import {
	getFileById,
	listFilesByPath,
	createFileMetadata,
	relocateFileMetadata,
	findFolderRowByPath,
} from './fileService.js';
import { getAccountById } from './accountService.js';
import { createAdapter } from './adapterRegistry.js';
import { syncAccount } from './syncService.js';
import { transfer } from './transferService.js';

function normalizePath(input = '/') {
	if (!input || input === '/') return '/';
	const cleaned = input.startsWith('/') ? input : `/${input}`;
	return cleaned.endsWith('/') ? cleaned : `${cleaned}/`;
}

// Error dengan status HTTP eksplisit — route memetakan ini langsung ke res.status().
export class MoveError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.name = 'MoveError';
		this.status = status;
	}
}

/**
 * Move/Copy file/folder. Akun-sama = move/copy native (M1/M2). Lintas akun (file &
 * folder rekursif) = di-route ke engine Transfer (M3/M4, server-side streaming) yang
 * return `transfer_id` cepat. `crossAccount` kini selalu kosong (disisakan untuk shape).
 *
 * @param {string} userId
 * @param {{ fileIds: string[], dest: { cloud_account_id?: string, virtual_path?: string, remote_parent_id?: string }, mode?: 'move'|'copy' }} params
 * @returns {Promise<{ moved: Array, transfers: Array, crossAccount: Array }>}
 */
export async function moveFiles(userId, { fileIds, dest, mode = 'move' }) {
	const normalizedMode = mode === 'copy' ? 'copy' : 'move';
	const destVirtualPath = normalizePath(dest?.virtual_path || '/');

	const destAccountId = dest?.cloud_account_id;
	if (!destAccountId) {
		throw new MoveError('A destination account is required', 400);
	}

	const destAccount = getAccountById(userId, destAccountId);
	if (!destAccount || destAccount.status !== 'active') {
		throw new MoveError('The destination account is no longer connected', 409);
	}

	// Resolusi remote parent id tujuan: pakai yang dikirim client, atau cari baris folder lokal.
	// Root ("/") dibiarkan null → adapter menyelesaikannya via ensureRemotePath.
	let destRemoteParentId = dest?.remote_parent_id || null;
	if (!destRemoteParentId && destVirtualPath !== '/') {
		const destFolder = findFolderRowByPath(userId, destAccountId, destVirtualPath);
		if (destFolder) {
			destRemoteParentId = destFolder.remote_file_id;
		}
	}

	const moved = [];
	const transfers = [];
	const crossAccount = [];
	const touchedAccountIds = new Set();

	for (const fileId of fileIds) {
		if (String(fileId).startsWith('shared:')) {
			throw new MoveError('Shared items cannot be moved or copied', 400);
		}

		const file = getFileById(userId, fileId);
		if (!file) {
			throw new MoveError('One or more files were not found', 404);
		}

		const sourceAccount = getAccountById(userId, file.cloud_account_id);
		if (!sourceAccount || sourceAccount.status !== 'active') {
			throw new MoveError('The file account is no longer connected', 409);
		}

		// Lintas akun → engine Transfer (server-side streaming, file & folder rekursif).
		if (file.cloud_account_id !== destAccountId) {
			const { transfer_id } = await transfer(userId, {
				sourceFileId: fileId,
				dest: {
					cloud_account_id: destAccountId,
					virtual_path: destVirtualPath,
					remote_parent_id: destRemoteParentId,
				},
				mode: normalizedMode,
			});
			transfers.push({ file_id: fileId, transfer_id });
			continue;
		}

		const sourceVirtualPath = normalizePath(file.virtual_path);

		// Cycle guard: folder tidak boleh dipindah ke dalam dirinya sendiri / turunannya.
		if (file.is_folder) {
			const ownContents = `${sourceVirtualPath}${file.file_name}/`.toLowerCase();
			if (destVirtualPath.toLowerCase().startsWith(ownContents)) {
				throw new MoveError('Cannot move a folder into its own subfolder', 400);
			}
		}

		// No-op: move ke folder yang sama.
		if (normalizedMode === 'move' && sourceVirtualPath === destVirtualPath) {
			moved.push({ id: fileId, file_name: file.file_name, virtual_path: destVirtualPath, mode: normalizedMode });
			continue;
		}

		// Collision check di tujuan (mode move).
		if (normalizedMode === 'move') {
			const collision = listFilesByPath(userId, destVirtualPath).find(
				(item) =>
					item.cloud_account_id === destAccountId &&
					item.id !== fileId &&
					item.file_name.toLowerCase() === file.file_name.toLowerCase(),
			);
			if (collision) {
				throw new MoveError('A file with that name already exists at the destination', 409);
			}
		}

		const adapter = createAdapter(sourceAccount);
		const result =
			normalizedMode === 'copy'
				? await adapter.copyFile(file, { destVirtualPath, destRemoteParentId })
				: await adapter.moveFile(file, { destVirtualPath, destRemoteParentId });

		// Update DB optimistic (sync di akhir adalah sumber kebenaran).
		if (normalizedMode === 'copy') {
			createFileMetadata({
				user_id: userId,
				virtual_path: destVirtualPath,
				file_name: result.fileName || file.file_name,
				is_folder: file.is_folder,
				size: file.size,
				mime_type: file.mime_type,
				cloud_account_id: destAccountId,
				remote_file_id: result.remoteFileId,
				remote_parent_id: result.remoteParentId,
			});
		} else {
			relocateFileMetadata(userId, fileId, {
				virtual_path: destVirtualPath,
				remote_parent_id: result.remoteParentId,
				remote_file_id: result.remoteFileId,
			});
		}

		touchedAccountIds.add(destAccountId);
		moved.push({
			id: fileId,
			file_name: result.fileName || file.file_name,
			virtual_path: destVirtualPath,
			mode: normalizedMode,
		});
	}

	// Rekonsiliasi akun yang tersentuh (rebuild penuh = sumber kebenaran).
	for (const accountId of touchedAccountIds) {
		const account = getAccountById(userId, accountId);
		if (account) {
			await syncAccount(userId, account);
		}
	}

	return { moved, transfers, crossAccount };
}
