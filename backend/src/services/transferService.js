import { createAdapter } from './adapterRegistry.js';
import { getAccountById, markAccountStatus, updateAccountUsage } from './accountService.js';
import {
	getFileById,
	createFileMetadata,
	getFileByRemoteId,
	deleteFileMetadataById,
	listSubtree,
} from './fileService.js';
import { selectBestAccount } from './spaceAllocator.js';
import { syncAccount } from './syncService.js';
import { emitUploadEvent } from './websocketHub.js';
import {
	createTransferSession,
	getTransferSession,
	getTransferSessionForUser,
	updateTransferSession,
} from './transferSessionService.js';
import { isAuthError } from '../utils/providerErrors.js';

// Error dengan status HTTP eksplisit — route memetakan langsung ke res.status().
export class TransferError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.name = 'TransferError';
		this.status = status;
	}
}

function normalizePath(input = '/') {
	if (!input || input === '/') return '/';
	const cleaned = input.startsWith('/') ? input : `/${input}`;
	return cleaned.endsWith('/') ? cleaned : `${cleaned}/`;
}

// Stream download aktif per transfer (untuk cancel mid-flight destroy).
const activeStreams = new Map();

/**
 * Mulai transfer lintas akun (server-side streaming). Return cepat; streaming async.
 * Mendukung single file (M3) dan folder rekursif (M4, abort-on-first-error).
 *
 * @param {string} userId
 * @param {{ sourceFileId: string, dest: { cloud_account_id?: string, virtual_path?: string, remote_parent_id?: string }, mode?: 'move'|'copy' }} params
 * @returns {Promise<{ transfer_id: string }>}
 */
export async function transfer(userId, { sourceFileId, dest, mode = 'move' }) {
	const normalizedMode = mode === 'copy' ? 'copy' : 'move';

	if (String(sourceFileId).startsWith('shared:')) {
		throw new TransferError('Shared items cannot be transferred', 400);
	}

	const sourceFile = getFileById(userId, sourceFileId);
	if (!sourceFile) {
		throw new TransferError('Source file not found', 404);
	}

	const sourceAccount = getAccountById(userId, sourceFile.cloud_account_id);
	if (!sourceAccount || sourceAccount.status !== 'active') {
		throw new TransferError('The source account is no longer connected', 409);
	}

	// Ukuran total: file = size sendiri; folder = jumlah size semua file descendant.
	let size;
	if (sourceFile.is_folder) {
		const contentsPath = normalizePath(`${sourceFile.virtual_path}${sourceFile.file_name}/`);
		const subtree = listSubtree(userId, sourceFile.cloud_account_id, contentsPath);
		size = subtree
			.filter((row) => !row.is_folder)
			.reduce((sum, row) => sum + (Number(row.size) || 0), 0);
	} else {
		size = Number(sourceFile.size) || 0;
	}

	// Resolusi akun tujuan: explicit (routing dari move) atau strategi alokasi.
	const { selected, fallbackChain } = selectBestAccount(userId, size, dest?.cloud_account_id || null);

	// Quota check dini: gagal bila tak ada satupun kandidat yang muat.
	if (size > 0) {
		const candidates = [selected, ...fallbackChain];
		const fits = candidates.some((account) => (Number(account.freeSpace) || 0) >= size);
		if (!fits) {
			throw new TransferError('Not enough free space in the destination account', 507);
		}
	}

	const session = createTransferSession({
		user_id: userId,
		source_file_id: sourceFileId,
		source_account_id: sourceAccount.id,
		dest_account_id: selected.id,
		dest_virtual_path: normalizePath(dest?.virtual_path || '/'),
		dest_remote_parent_id: dest?.remote_parent_id || null,
		mode: normalizedMode,
		total_bytes: size,
		file_name: sourceFile.file_name,
		is_folder: Boolean(sourceFile.is_folder),
		// Folder pakai akun tujuan tunggal (struktur konsisten); fallback hanya single file.
		fallback_chain: sourceFile.is_folder ? [] : fallbackChain.map((account) => account.id),
	});

	// Fire-and-forget: streaming jalan di background, progres via WS.
	runTransfer(session).catch((error) => console.error('Transfer run failed', error));

	return { transfer_id: session.id };
}

async function runTransfer(session) {
	const userId = session.user_id;

	updateTransferSession(session.id, { status: 'transferring' });
	emitUploadEvent(session.id, {
		type: 'transfer:started',
		uploadId: session.id,
		percent: 0,
		status: 'transferring',
	});

	const sourceAccount = getAccountById(userId, session.source_account_id);
	const sourceFile = getFileById(userId, session.source_file_id);

	try {
		if (!sourceAccount || !sourceFile) {
			throw new Error('Source file or account no longer available');
		}
		const sourceAdapter = createAdapter(sourceAccount);

		let account;
		let metadata;

		if (session.is_folder) {
			account = await runFolderTransfer(session, sourceAccount, sourceFile, sourceAdapter);
			metadata = {
				id: null,
				file_name: sourceFile.file_name,
				is_folder: true,
				virtual_path: session.dest_virtual_path,
				cloud_account_id: account.id,
			};
		} else {
			({ account, metadata } = await runSingleFileTransfer(session, sourceAccount, sourceFile, sourceAdapter));
		}

		updateTransferSession(session.id, {
			status: 'completed',
			dest_account_id: account.id,
			transferred_bytes: session.total_bytes,
		});
		emitUploadEvent(session.id, {
			type: 'transfer:complete',
			uploadId: session.id,
			percent: 100,
			status: 'completed',
			file: metadata,
		});
	} catch (error) {
		if (isAuthError(error)) {
			markAccountStatus(userId, session.dest_account_id, 'invalid_token');
		}
		const cancelled = getTransferSession(session.id)?.cancelled;
		updateTransferSession(session.id, {
			status: cancelled ? 'cancelled' : 'failed',
			error: error.message,
		});
		emitUploadEvent(session.id, {
			type: 'transfer:error',
			uploadId: session.id,
			status: cancelled ? 'cancelled' : 'failed',
			message: error.message,
		});
		// Failure/cancel: source TIDAK dihapus (move hapus hanya setelah dest sukses).
	}
}

// Stream satu file dari source ke akun tujuan tertentu, lapor progres agregat.
async function streamFileTo({
	session,
	sourceAdapter,
	sourceRow,
	destAdapter,
	destVirtualPath,
	destRemoteParentId,
	baseBytes,
}) {
	if (getTransferSession(session.id)?.cancelled) {
		throw new Error('Transfer cancelled');
	}

	const downloadStream = await sourceAdapter.getDownloadStream(sourceRow);
	activeStreams.set(session.id, downloadStream);

	try {
		return await destAdapter.uploadStream({
			stream: downloadStream,
			size: Number(sourceRow.size) || 0,
			fileName: sourceRow.file_name,
			mimeType: sourceRow.mime_type,
			virtualPath: destVirtualPath,
			remoteParentId: destRemoteParentId,
			onProgress: (bytes) => {
				const total = session.total_bytes || 0;
				const cumulative = baseBytes + bytes;
				const percent = total ? Math.min(100, Math.round((cumulative / total) * 100)) : 0;
				updateTransferSession(session.id, { transferred_bytes: cumulative });
				emitUploadEvent(session.id, {
					type: 'transfer:progress',
					uploadId: session.id,
					bytes: cumulative,
					percent,
					status: 'transferring',
				});
			},
		});
	} finally {
		activeStreams.delete(session.id);
	}
}

async function runSingleFileTransfer(session, sourceAccount, sourceFile, sourceAdapter) {
	const userId = session.user_id;

	let activeAccountId = session.dest_account_id;
	const tried = new Set();

	const attemptTransfer = async (accountId) => {
		tried.add(accountId);

		if (getTransferSession(session.id)?.cancelled) {
			throw new Error('Transfer cancelled');
		}

		const account = getAccountById(userId, accountId);
		if (!account) {
			throw new Error('Target transfer account not found');
		}
		const adapter = createAdapter(account);

		// remote_parent_id hanya valid untuk akun tujuan asli; fallback resolve via virtualPath.
		const result = await streamFileTo({
			session,
			sourceAdapter,
			sourceRow: sourceFile,
			destAdapter: adapter,
			destVirtualPath: session.dest_virtual_path,
			destRemoteParentId: accountId === session.dest_account_id ? session.dest_remote_parent_id : null,
			baseBytes: 0,
		});

		return { result, account };
	};

	let uploadResponse;
	let account;

	try {
		({ result: uploadResponse, account } = await attemptTransfer(activeAccountId));
	} catch (error) {
		if (isAuthError(error)) {
			markAccountStatus(userId, activeAccountId, 'invalid_token');
		}
		const fallbackId = session.fallback_chain.find((id) => !tried.has(id));
		if (!fallbackId || getTransferSession(session.id)?.cancelled) {
			throw error;
		}
		activeAccountId = fallbackId;
		({ result: uploadResponse, account } = await attemptTransfer(activeAccountId));
	}

	updateAccountUsage(userId, account.id, Number(account.used_space) + Number(session.total_bytes));

	let metadata = createFileMetadata({
		user_id: userId,
		virtual_path: session.dest_virtual_path,
		file_name: uploadResponse.fileName || session.file_name,
		is_folder: false,
		size: session.total_bytes,
		mime_type: sourceFile.mime_type,
		cloud_account_id: account.id,
		remote_file_id: uploadResponse.remoteFileId,
		remote_parent_id: uploadResponse.remoteParentId,
	});

	// Move: hapus sumber HANYA setelah dest sukses.
	if (session.mode === 'move') {
		try {
			await sourceAdapter.deleteFile(sourceFile);
			deleteFileMetadataById(userId, session.source_file_id);
			syncAccount(userId, sourceAccount).catch((err) =>
				console.error('Background sync failed after transfer source delete', err),
			);
		} catch (deleteError) {
			console.error('Transfer move: source delete failed (dest kept)', deleteError);
		}
	}

	syncAccount(userId, account).catch((err) =>
		console.error('Background sync failed after transfer', err),
	);
	metadata = getFileByRemoteId(userId, account.id, uploadResponse.remoteFileId) || metadata;

	return { account, metadata };
}

async function runFolderTransfer(session, sourceAccount, sourceFolder, sourceAdapter) {
	const userId = session.user_id;

	const destAccount = getAccountById(userId, session.dest_account_id);
	if (!destAccount) {
		throw new Error('Target transfer account not found');
	}
	const destAdapter = createAdapter(destAccount);

	const sourceContentsPath = normalizePath(`${sourceFolder.virtual_path}${sourceFolder.file_name}/`);
	const destContentsPath = normalizePath(`${session.dest_virtual_path}${sourceFolder.file_name}/`);

	// Buat folder root di tujuan.
	const root = await destAdapter.createFolder({
		name: sourceFolder.file_name,
		virtualPath: session.dest_virtual_path,
		remoteParentId: session.dest_remote_parent_id,
	});

	// Map: contents-path sumber → { destPath, remoteParentId } di tujuan.
	const parentMap = new Map();
	parentMap.set(sourceContentsPath, { destPath: destContentsPath, remoteParentId: root.remoteFileId });

	const subtree = listSubtree(userId, sourceAccount.id, sourceContentsPath);
	const folders = subtree.filter((row) => row.is_folder);
	const files = subtree.filter((row) => !row.is_folder);

	// Buat folder top-down (listSubtree urut path length ASC → parent dulu).
	for (const folder of folders) {
		if (getTransferSession(session.id)?.cancelled) {
			throw new Error('Transfer cancelled');
		}
		const srcParent = normalizePath(folder.virtual_path);
		const mapped = parentMap.get(srcParent);
		if (!mapped) continue; // orphan guard (parent tak ter-map)

		const created = await destAdapter.createFolder({
			name: folder.file_name,
			virtualPath: mapped.destPath,
			remoteParentId: mapped.remoteParentId,
		});

		parentMap.set(normalizePath(`${srcParent}${folder.file_name}/`), {
			destPath: normalizePath(`${mapped.destPath}${folder.file_name}/`),
			remoteParentId: created.remoteFileId,
		});
	}

	// Stream tiap file ke folder dest yang ter-map; progres agregat. Abort-on-first-error.
	let baseBytes = 0;
	for (const file of files) {
		const srcParent = normalizePath(file.virtual_path);
		const mapped = parentMap.get(srcParent);
		if (!mapped) continue;

		await streamFileTo({
			session,
			sourceAdapter,
			sourceRow: file,
			destAdapter,
			destVirtualPath: mapped.destPath,
			destRemoteParentId: mapped.remoteParentId,
			baseBytes,
		});
		baseBytes += Number(file.size) || 0;
	}

	updateAccountUsage(userId, destAccount.id, Number(destAccount.used_space) + Number(session.total_bytes));

	// Move: hapus seluruh source tree HANYA setelah dest sukses.
	if (session.mode === 'move') {
		try {
			await sourceAdapter.deleteFile(sourceFolder);
			for (const row of subtree) {
				deleteFileMetadataById(userId, row.id);
			}
			deleteFileMetadataById(userId, sourceFolder.id);
			syncAccount(userId, sourceAccount).catch((err) =>
				console.error('Background sync failed after transfer source delete', err),
			);
		} catch (deleteError) {
			console.error('Transfer move: source folder delete failed (dest kept)', deleteError);
		}
	}

	syncAccount(userId, destAccount).catch((err) =>
		console.error('Background sync failed after folder transfer', err),
	);

	return destAccount;
}

export function cancelTransfer(userId, id) {
	const session = getTransferSessionForUser(userId, id);
	if (!session) return null;

	updateTransferSession(id, { cancelled: true });

	const stream = activeStreams.get(id);
	if (stream && typeof stream.destroy === 'function') {
		stream.destroy(new Error('Transfer cancelled'));
	}

	return getTransferSession(id);
}
