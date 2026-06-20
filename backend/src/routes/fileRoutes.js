import { Router } from 'express';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import archiver from 'archiver';

import { listFilesByPath, getFileById, getFileByRemoteId, listRecentFiles, listStarredFiles, searchFiles, setFileStarred, updateFileStarredByRemoteId, findFoldersByNameAndPath, listSubtree, listAccountsWithContents } from '../services/fileService.js';
import { getAccountById, getActiveAccounts } from '../services/accountService.js';
import { createAdapter } from '../services/adapterRegistry.js';
import { selectBestAccount } from '../services/spaceAllocator.js';
import { syncAccount } from '../services/syncService.js';
import { moveFiles, MoveError } from '../services/fileMoveService.js';
import { requireAppUser } from '../middleware/authMiddleware.js';

const router = Router();

router.use(requireAppUser);

function encodeSharedFileId(accountId, remoteFileId) {
	return `shared:${accountId}:${Buffer.from(String(remoteFileId)).toString('base64url')}`;
}

function mapSharedItem(userId, account, item, localFile = getFileByRemoteId(userId, account.id, item.remote_file_id)) {
	return {
		...(localFile || {}),
		...item,
		id: encodeSharedFileId(account.id, item.remote_file_id),
		cloud_account_id: account.id,
		provider: localFile?.provider || account.provider,
		email: item.owner_email || localFile?.email || account.email,
		createdTime: item.createdTime,
		modifiedTime: item.modifiedTime,
		capabilities: {
			starred: Boolean(item.capabilities?.starred ?? localFile?.capabilities?.starred ?? account.provider === 'google_drive'),
			rename: Boolean(item.capabilities?.rename ?? localFile?.capabilities?.rename ?? false),
			delete: Boolean(item.capabilities?.delete ?? localFile?.capabilities?.delete ?? false),
		},
	};
}

function decodeSharedFileId(fileId) {
	if (!fileId?.startsWith('shared:')) return null;
	const [, accountId, encodedRemoteFileId] = fileId.split(':');
	if (!accountId || !encodedRemoteFileId) return null;
	return {
		accountId,
		remoteFileId: Buffer.from(encodedRemoteFileId, 'base64url').toString('utf8'),
	};
}

async function getSharedFileContext(userId, fileId) {
	const parsed = decodeSharedFileId(fileId);
	if (!parsed) {
		return { file: null, account: null, adapter: null };
	}

	const account = getAccountById(userId, parsed.accountId);
	if (!account) {
		return { file: null, account: null, adapter: null };
	}

	const adapter = createAdapter(account);
	const sharedItems = await adapter.listSharedWithMe();
	let file = sharedItems.find((item) => item.remote_file_id === parsed.remoteFileId);
	if (!file) {
		try {
			const details = await adapter.getFileDetails({ remote_file_id: parsed.remoteFileId });
			if (details?.remote_file_id) {
				file = {
					file_name: details.file_name || details.name,
					is_folder: Boolean(details.is_folder),
					is_starred: 0,
					size: Number(details.size || 0),
					mime_type: details.mime_type || details.mimeType || null,
					remote_file_id: details.remote_file_id,
					remote_parent_id: details.remote_parent_id || null,
					remote_drive_id: details.remote_drive_id || null,
					createdTime: details.createdTime || null,
					modifiedTime: details.modifiedTime || null,
					owner_name: details.owner_name || null,
					owner_email: details.owner_email || account.email,
				};
			}
		} catch {
			file = null;
		}
	}
	if (!file) {
		return { file: null, account, adapter };
	}

	return {
		file: {
			...file,
			id: fileId,
			cloud_account_id: account.id,
			provider: account.provider,
			email: file.owner_email || account.email,
			capabilities: {
				starred: Boolean(file.capabilities?.starred ?? account.provider === 'google_drive'),
				rename: Boolean(file.capabilities?.rename ?? false),
				delete: Boolean(file.capabilities?.delete ?? false),
			},
		},
		account,
		adapter,
	};
}

async function getFileContext(userId, fileId) {
	const file = getFileById(userId, fileId);
	if (!file) {
		return getSharedFileContext(userId, fileId);
	}

	const account = getAccountById(userId, file.cloud_account_id);
	if (!account) {
		return { file, account: null, adapter: null };
	}

	return {
		file,
		account,
		adapter: createAdapter(account),
	};
}

function ensureFileContext(context, res) {
	if (!context.file) {
		res.status(404).json({ error: 'File not found' });
		return false;
	}

	if (!context.account || context.account.status !== 'active' || !context.adapter) {
		res.status(409).json({ error: 'The file account is no longer connected' });
		return false;
	}

	return true;
}

async function deleteContextFile(userId, context, rawId = context?.file?.id, options = {}) {
	const { sync = true } = options;
	await context.adapter.deleteFile(context.file);

	if (sync && context.account) {
		await syncAccount(userId, context.account);
	}
}

async function listSharedWithMeFiles(userId) {
	const accounts = getActiveAccounts(userId);
	const settled = await Promise.allSettled(accounts.map(async (account) => {
		const adapter = createAdapter(account);
		const items = await adapter.listSharedWithMe();

		return items
			.map((item) => mapSharedItem(userId, account, item))
			.filter((item) => Boolean(item.remote_file_id));
	}));

	return settled
		.filter((result) => result.status === 'fulfilled')
		.flatMap((result) => result.value)
		.filter((item) => Boolean(item.remote_file_id))
		.filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index)
		.sort((left, right) => {
			const leftTime = new Date(left.modifiedTime || left.createdTime || 0).getTime();
			const rightTime = new Date(right.modifiedTime || right.createdTime || 0).getTime();
			if (leftTime !== rightTime) return rightTime - leftTime;
			return (left.file_name || '').localeCompare(right.file_name || '', 'id');
		});
}

router.get('/files', async (req, res, next) => {
	try {
		const files = req.query.search
			? searchFiles(req.user.id, req.query.search, req.query.limit)
			: req.query.starred === '1'
				? listStarredFiles(req.user.id)
				: req.query.recent === '1'
					? listRecentFiles(req.user.id)
					: req.query.shared === '1'
						? await listSharedWithMeFiles(req.user.id)
						: listFilesByPath(req.user.id, req.query.path || '/', req.query.cloud_account_id || null);
		res.json({ data: files });
	} catch (error) {
		next(error);
	}
});

router.get('/files/:id/shared-children', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) {
			return;
		}

		if (!context.file.is_folder) {
			return res.status(400).json({ error: 'Only folders can be opened' });
		}

		const items = await context.adapter.listSharedFolderChildren(context.file);
		return res.json({
			data: items.map((item) => mapSharedItem(req.user.id, context.account, item)).filter((item) => Boolean(item.remote_file_id)),
		});
	} catch (error) {
		next(error);
	}
});

router.patch('/files/:id/star', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) {
			return;
		}

		const isStarred = Boolean(req.body?.is_starred ?? req.body?.isStarred ?? true);
		const supportsStarred = Boolean(context.adapter.getCapabilities?.().starred);

		if (supportsStarred) {
			await context.adapter.setFileStarred(context.file, isStarred);
			await syncAccount(req.user.id, context.account);
			if (!decodeSharedFileId(context.file.id)) {
				updateFileStarredByRemoteId(req.user.id, context.account.id, context.file.remote_file_id, isStarred);
			}
		} else {
			setFileStarred(req.user.id, context.file.id, isStarred);
		}
		return res.json({ data: { success: true, is_starred: isStarred, provider_sync: supportsStarred } });
	} catch (error) {
		next(error);
	}
});

router.post('/files/bulk/delete', async (req, res, next) => {
	try {
		const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.filter(Boolean))] : [];
		if (!ids.length) {
			return res.status(400).json({ error: 'At least one file id is required' });
		}

		const contexts = await Promise.all(ids.map(async (id) => ({ id, ...await getFileContext(req.user.id, id) })));
		const invalid = contexts.find((context) => !context.file || !context.account || context.account.status !== 'active' || !context.adapter);
		if (invalid) {
			return res.status(invalid.file ? 409 : 404).json({ error: invalid.file ? 'One or more file accounts are no longer connected' : 'One or more files were not found' });
		}

		const touchedAccountIds = new Set();
		for (const context of contexts) {
			await deleteContextFile(req.user.id, context, context.id, { sync: false });
			touchedAccountIds.add(context.account.id);
		}

		for (const accountId of touchedAccountIds) {
			const account = getAccountById(req.user.id, accountId);
			if (account) {
				await syncAccount(req.user.id, account);
			}
		}

		return res.json({ data: { success: true, count: contexts.length } });
	} catch (error) {
		next(error);
	}
});

router.post('/files/move', async (req, res, next) => {
	try {
		const fileIds = Array.isArray(req.body?.file_ids)
			? [...new Set(req.body.file_ids.filter(Boolean))]
			: [];
		const dest = req.body?.dest;
		const mode = req.body?.mode === 'copy' ? 'copy' : 'move';

		if (!fileIds.length) {
			return res.status(400).json({ error: 'At least one file id is required' });
		}
		if (!dest || typeof dest !== 'object') {
			return res.status(400).json({ error: 'A destination is required' });
		}

		const result = await moveFiles(req.user.id, { fileIds, dest, mode });

		// Cross-account file → otomatis jadi transfer (M3). Folder lintas akun belum didukung (M4).
		return res.json({
			data: {
				moved: result.moved,
				transfers: result.transfers,
				unsupported: result.crossAccount,
			},
		});
	} catch (error) {
		if (error instanceof MoveError) {
			return res.status(error.status).json({ error: error.message });
		}
		return next(error);
	}
});

router.get('/files/:id', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) {
			return;
		}

		const details = await context.adapter.getFileDetails(context.file);
		return res.json({
			data: {
				...context.file,
				...details,
			},
		});
	} catch (error) {
		next(error);
	}
});

router.get('/files/:id/download', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) {
			return;
		}
		const stream = await context.adapter.getDownloadStream(context.file);

		res.setHeader('Content-Disposition', `attachment; filename="${context.file.file_name}"`);
		res.setHeader('Content-Type', context.file.mime_type || 'application/octet-stream');
		if (!context.file.is_folder && context.file.size) {
			res.setHeader('Content-Length', String(context.file.size));
		}
		stream.pipe(res);
	} catch (error) {
		next(error);
	}
});

const PROVIDER_LABELS = {
	google_drive: 'Google Drive',
	dropbox: 'Dropbox',
	onedrive: 'OneDrive',
	yandex: 'Yandex Disk',
	pcloud: 'pCloud',
	s3: 'Amazon S3',
	mega: 'MEGA',
};

function providerLabel(provider) {
	return PROVIDER_LABELS[provider] || provider || 'Cloud';
}

// Buang char ilegal path zip (slash, backslash, dan reserved Windows).
function sanitizeZipSegment(name) {
	return String(name || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim() || 'unknown';
}

function normalizeFolderPath(input = '/') {
	if (!input || input === '/') return '/';
	const cleaned = input.startsWith('/') ? input : `/${input}`;
	return cleaned.endsWith('/') ? cleaned : `${cleaned}/`;
}

// Stream tiap file subtree satu akun ke archive; path relatif terhadap `contentsPath`.
// `prefix` opsional (mode B = label akun). File gagal → push ke `errors`, JANGAN abort.
async function appendAccountSubtree(userId, account, contentsPath, archive, errors, prefix = '') {
	const adapter = createAdapter(account);
	const rows = listSubtree(userId, account.id, contentsPath).filter((row) => !row.is_folder);

	for (const file of rows) {
		const relativeDir = file.virtual_path.slice(contentsPath.length); // '' atau 'Sub/Nested/'
		const zipName = `${prefix}${relativeDir}${file.file_name}`;
		try {
			const stream = await adapter.getDownloadStream(file);
			archive.append(stream, { name: zipName });
			// Tunggu entry selesai diproses sebelum buka stream berikutnya (hindari banyak stream live).
			await new Promise((resolve, reject) => {
				archive.once('entry', resolve);
				stream.once('error', reject);
			});
		} catch (error) {
			errors.push(`${zipName}: ${error.message}`);
		}
	}
}

router.get('/files/:id/download-folder', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) {
			return;
		}
		if (!context.file.is_folder) {
			return res.status(400).json({ error: 'Only folders can be downloaded as a zip' });
		}

		const contentsPath = normalizeFolderPath(`${context.file.virtual_path}${context.file.file_name}/`);
		const accounts = listAccountsWithContents(req.user.id, contentsPath);
		const isUnion = accounts.length > 1; // >1 akun → mode B (subfolder per-akun ber-label)

		const safeName = sanitizeZipSegment(context.file.file_name);
		res.setHeader('Content-Type', 'application/zip');
		res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);
		
		const archive = archiver('zip', { zlib: { level: 6 } });
		const archive = archiverInstance('zip', { zlib: { level: 6 } });
		const errors = [];

		archive.on('warning', (err) => { if (err.code !== 'ENOENT') console.error('Zip warning', err); });
		archive.on('error', (err) => {
			console.error('Zip error', err);
			if (!res.headersSent) res.status(500).json({ error: 'Failed to build zip' });
			res.destroy();
		});
		// Klien tutup koneksi (cancel) → hentikan zip.
		req.on('close', () => { if (!res.writableEnded) archive.abort(); });

		archive.pipe(res);

		if (isUnion) {
			// Mode B: namespace per-akun → tak ada collision lintas akun.
			for (const row of accounts) {
				const account = getAccountById(req.user.id, row.cloud_account_id);
				if (!account || account.status !== 'active') continue;
				const label = sanitizeZipSegment(`${providerLabel(account.provider)} - ${account.email}`);
				await appendAccountSubtree(req.user.id, account, contentsPath, archive, errors, `${label}/`);
			}
		} else {
			// Mode A: isi folder langsung, struktur natural.
			await appendAccountSubtree(req.user.id, context.account, contentsPath, archive, errors);
		}

		if (errors.length) {
			archive.append(
				`File berikut gagal diunduh dan dilewati:\n\n${errors.join('\n')}\n`,
				{ name: '_errors.txt' },
			);
		}

		await archive.finalize();
	} catch (error) {
		next(error);
	}
});

router.get('/files/:id/direct-download', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) {
			return;
		}

		if (context.file.is_folder) {
			return res.json({ use_stream: true });
		}

		const { supportsDirectDownload } = await import('../utils/directTransfer.js');
		if (supportsDirectDownload(context.account.provider)) {
			if (typeof context.adapter.getDirectDownloadUrl === 'function') {
				const result = await context.adapter.getDirectDownloadUrl(context.file);
				return res.json({ data: result });
			}
		}

		return res.json({ data: { url: null, use_stream: true } });
	} catch (error) {
		next(error);
	}
});

router.get('/files/:id/preview', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) {
			return;
		}

		if (context.file.is_folder) {
			return res.status(400).json({ error: 'Folder preview is not supported' });
		}

		const mimeType = context.file.mime_type || 'application/octet-stream';
		const isPreviewable = /^(image|video|audio|text)\//.test(mimeType)
			|| mimeType === 'application/pdf'
			|| mimeType === 'application/json';

		if (!isPreviewable) {
			return res.status(415).json({ error: 'Preview is not supported for this file type' });
		}

		const stream = await context.adapter.getDownloadStream(context.file);

		res.setHeader('Content-Disposition', `inline; filename="${context.file.file_name}"`);
		res.setHeader('Content-Type', mimeType);
		if (context.file.size) {
			res.setHeader('Content-Length', String(context.file.size));
		}

		stream.pipe(res);
	} catch (error) {
		next(error);
	}
});

router.patch('/files/:id/rename', async (req, res, next) => {
	try {
		const { name } = req.body;
		if (!name?.trim()) {
			return res.status(400).json({ error: 'New name is required' });
		}

		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) {
			return;
		}

		await context.adapter.renameFile(context.file, name.trim());
		await syncAccount(req.user.id, context.account);

		return res.json({ data: { success: true } });
	} catch (error) {
		next(error);
	}
});

router.delete('/files/:id', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) {
			return;
		}

		// Kalau folder, hapus semua folder dengan nama + path sama di semua provider
		if (context.file.is_folder) {
			const siblings = findFoldersByNameAndPath(
				req.user.id,
				context.file.file_name,
				context.file.virtual_path,
			);

			const touchedAccountIds = new Set();
			for (const sibling of siblings) {
				const siblingContext = await getFileContext(req.user.id, sibling.id);
				if (!siblingContext.file || !siblingContext.account || !siblingContext.adapter) continue;
				await deleteContextFile(req.user.id, siblingContext, sibling.id, { sync: false });
				touchedAccountIds.add(siblingContext.account.id);
			}

			for (const accountId of touchedAccountIds) {
				const account = getAccountById(req.user.id, accountId);
				if (account) await syncAccount(req.user.id, account);
			}

			return res.json({ data: { success: true } });
		}

		// Kalau file biasa, hapus seperti biasa
		await deleteContextFile(req.user.id, context, req.params.id);
		return res.json({ data: { success: true } });
	} catch (error) {
		next(error);
	}
});

router.post('/files/folders', async (req, res, next) => {
	try {
		const { name, virtual_path = '/' } = req.body;

		if (!name?.trim()) {
			return res.status(400).json({ error: 'Folder name is required' });
		}

		const { selected } = selectBestAccount(req.user.id, 0);
		const account = getAccountById(req.user.id, selected.id);
		const adapter = createAdapter(account);

		await adapter.createFolder({
			name: name.trim(),
			virtualPath: virtual_path,
		});

		await syncAccount(req.user.id, account);

		return res.status(201).json({ data: { success: true } });
	} catch (error) {
		next(error);
	}
});

export default router;
