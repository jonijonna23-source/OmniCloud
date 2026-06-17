import { Router } from 'express';
import { requireAppUser } from '../middleware/authMiddleware.js';
import { selectBestAccount } from '../services/spaceAllocator.js';
import { createUploadSession } from '../services/uploadSessionService.js';
import { handleUpload } from '../services/uploadService.js';
import { getAccountById } from '../services/accountService.js';
import { createAdapter } from '../services/adapterRegistry.js';
import { createFileMetadata } from '../services/fileService.js';
import { syncAccount } from '../services/syncService.js';

const router = Router();

router.use(requireAppUser);

router.post('/uploads/initiate', (req, res) => {
	const { file_name, size, mime_type, virtual_path = '/', remote_parent_id = null, target_account_id = null } = req.body;

	if (!file_name || size === undefined || size === null) {
		return res.status(400).json({ error: 'file_name and size are required' });
	}

	const allocation = selectBestAccount(req.user.id, Number(size), target_account_id);
	const session = createUploadSession({
		user_id: req.user.id,
		file_name,
		size: Number(size),
		mime_type,
		virtual_path,
		remote_parent_id,
		cloud_account_id: allocation.selected.id,
		fallback_chain: allocation.fallbackChain.map((account) => account.id),
	});

	return res.status(201).json({
		data: {
			upload_id: session.id,
			session_token: session.token,
			target_account: {
				id: allocation.selected.id,
				provider: allocation.selected.provider,
				email: allocation.selected.email,
			},
		},
	});
});

router.post('/uploads/:uploadId/stream', async (req, res, next) => {
	try {
		const metadata = await handleUpload(req, req.params.uploadId);
		res.status(201).json({ data: metadata });
	} catch (error) {
		next(error);
	}
});

router.post('/uploads/initiate-direct', async (req, res, next) => {
	try {
		const { file_name, size, mime_type, virtual_path = '/', remote_parent_id = null, target_account_id = null } = req.body;

		if (!file_name || size === undefined || size === null) {
			return res.status(400).json({ error: 'file_name and size are required' });
		}

		const allocation = selectBestAccount(req.user.id, Number(size), target_account_id);
		const { supportsDirectUpload } = await import('../utils/directTransfer.js');
		
		if (!supportsDirectUpload(allocation.selected.provider, Number(size))) {
			return res.json({ data: { use_stream: true } });
		}

		const account = getAccountById(req.user.id, allocation.selected.id);
		const adapter = createAdapter(account);

		if (typeof adapter.createResumableUploadUrl === 'function') {
			const result = await adapter.createResumableUploadUrl({
				fileName: file_name,
				size: Number(size),
				mimeType: mime_type,
				virtualPath: virtual_path,
				remoteParentId: remote_parent_id,
			});
			return res.json({ data: { ...result, target_account_id: account.id } });
		}
		
		if (typeof adapter.createUploadSession === 'function') {
			const result = await adapter.createUploadSession({
				fileName: file_name,
				size: Number(size),
				mimeType: mime_type,
				virtualPath: virtual_path,
				remoteParentId: remote_parent_id,
			});
			return res.json({ data: { ...result, target_account_id: account.id } });
		}

		return res.json({ data: { use_stream: true } });
	} catch (error) {
		next(error);
	}
});

router.post('/uploads/direct-complete', async (req, res, next) => {
	try {
		const { upload_id, remote_file_id, cloud_account_id, file_name, size, mime_type, virtual_path, remote_parent_id } = req.body;
		
		if (!remote_file_id || !cloud_account_id) {
			return res.status(400).json({ error: 'remote_file_id and cloud_account_id are required' });
		}

		const account = getAccountById(req.user.id, cloud_account_id);
		if (!account) {
			return res.status(404).json({ error: 'Account not found' });
		}

		const adapter = createAdapter(account);
		const fileRecord = {
			remote_file_id,
			size: Number(size),
			file_name,
			mime_type,
			virtual_path,
			remote_parent_id
		};

		const details = await Promise.race([
			adapter.getFileDetails(fileRecord),
			new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 10000))
		]).catch(err => {
			if (err.message === 'TIMEOUT') {
				return 'TIMEOUT';
			}
			throw err;
		});

		if (details === 'TIMEOUT') {
			return res.status(504).json({ error: 'Gateway Timeout: Failed to fetch file details from provider' });
		}

		if (!details) {
			return res.status(404).json({ error: 'File not found on remote provider' });
		}

		// Use the details provided by the client, but check if details size exists and roughly matches
		if (details.size !== undefined && details.size !== Number(size)) {
			// Some providers might adjust size slightly but we should be careful.
			// Let's use the adapter's reported size just to be safe.
			fileRecord.size = details.size;
		}

		const finalMetadata = await createFileMetadata({
			userId: req.user.id,
			accountId: account.id,
			remoteFileId: details.remote_file_id || remote_file_id,
			remoteParentId: details.remote_parent_id || remote_parent_id,
			size: details.size || Number(size),
			fileName: details.name || file_name,
			mimeType: details.mime_type || mime_type,
			virtualPath: virtual_path || '/',
		});

		// Trigger sync asynchronously
		syncAccount(req.user.id, account).catch(err => console.error('Background sync failed after direct upload', err));

		return res.json({ data: finalMetadata });
	} catch (error) {
		next(error);
	}
});

export default router;
