import { Router } from 'express';
import { requireAppUser } from '../middleware/authMiddleware.js';
import { transfer, cancelTransfer, TransferError } from '../services/transferService.js';
import { getTransferSessionForUser } from '../services/transferSessionService.js';

const router = Router();

router.use(requireAppUser);

// Bentuk publik session — buang field internal (fallback_chain dll).
function publicSession(session) {
	return {
		id: session.id,
		source_file_id: session.source_file_id,
		dest_account_id: session.dest_account_id,
		dest_virtual_path: session.dest_virtual_path,
		mode: session.mode,
		status: session.status,
		total_bytes: session.total_bytes,
		transferred_bytes: session.transferred_bytes,
		file_name: session.file_name,
		is_folder: session.is_folder,
		error: session.error || null,
	};
}

router.post('/transfers/initiate', async (req, res, next) => {
	try {
		const sourceFileId = req.body?.source_file_id;
		const dest = req.body?.dest;
		const mode = req.body?.mode === 'copy' ? 'copy' : 'move';

		if (!sourceFileId) {
			return res.status(400).json({ error: 'A source file id is required' });
		}
		if (!dest || typeof dest !== 'object') {
			return res.status(400).json({ error: 'A destination is required' });
		}

		const result = await transfer(req.user.id, { sourceFileId, dest, mode });
		return res.status(201).json({ data: result });
	} catch (error) {
		if (error instanceof TransferError) {
			return res.status(error.status).json({ error: error.message });
		}
		return next(error);
	}
});

// Polling fallback (progres utama via WS /ws/uploads?uploadId=<transfer_id>).
router.get('/transfers/:id', (req, res) => {
	const session = getTransferSessionForUser(req.user.id, req.params.id);
	if (!session) {
		return res.status(404).json({ error: 'Transfer not found' });
	}
	return res.json({ data: publicSession(session) });
});

router.post('/transfers/:id/cancel', (req, res) => {
	const session = cancelTransfer(req.user.id, req.params.id);
	if (!session) {
		return res.status(404).json({ error: 'Transfer not found' });
	}
	return res.json({ data: { success: true } });
});

export default router;
