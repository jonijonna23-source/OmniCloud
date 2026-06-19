import { randomUUID } from 'crypto';

// Map in-memory meniru uploadSessionService — tidak persist lintas restart (sama seperti upload).
const sessions = new Map();

export function createTransferSession(payload) {
	const id = randomUUID();
	const session = {
		id,
		status: 'pending',
		transferred_bytes: 0,
		cancelled: false,
		createdAt: new Date().toISOString(),
		...payload,
	};

	sessions.set(id, session);
	return session;
}

export function getTransferSession(id) {
	return sessions.get(id);
}

export function getTransferSessionForUser(userId, id) {
	const session = sessions.get(id);
	if (!session || session.user_id !== userId) return null;
	return session;
}

export function updateTransferSession(id, patch) {
	const session = sessions.get(id);
	if (!session) return null;
	const next = { ...session, ...patch };
	sessions.set(id, next);
	return next;
}

export function removeTransferSession(id) {
	sessions.delete(id);
}
