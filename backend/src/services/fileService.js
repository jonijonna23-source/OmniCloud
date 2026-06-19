import { randomUUID } from 'crypto';
import { db } from '../config/database.js';
import { resolveMimeType } from '../utils/mime.js';

function normalizePath(input = '/') {
	if (!input || input === '/') return '/';
	const cleaned = input.startsWith('/') ? input : `/${input}`;
	return cleaned.endsWith('/') ? cleaned : `${cleaned}/`;
}

function buildDisplayNames(rows) {
	return rows.map((row) => ({
		...row,
		createdTime: row.remote_created_time || null,
		modifiedTime: row.remote_modified_time || null,
		capabilities: {
			starred: row.provider === 'google_drive',
			rename: true,
			delete: true,
			// Semua provider lokal kini mendukung move (relokasi dalam akun yang sama).
			move: true,
		},
	}));
}

export function listFilesByPath(userId, virtualPath = '/') {
	const normalized = normalizePath(virtualPath);
	const rows = db
		.prepare(`
      SELECT
        fm.*, ca.provider, ca.email
      FROM file_metadata fm
      INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
      WHERE fm.user_id = ?
        AND fm.virtual_path = ?
        AND ca.status = 'active'
      ORDER BY fm.is_folder DESC, fm.file_name COLLATE NOCASE ASC
    `)
		.all(userId, normalized);

	const built = buildDisplayNames(rows);

	// Deduplikasi folder dengan nama sama — tampilkan hanya satu
	const seenFolders = new Set();
	const deduped = built.filter((item) => {
		if (!item.is_folder) return true; // file selalu tampil
		const key = item.file_name.toLowerCase();
		if (seenFolders.has(key)) return false; // duplikat, skip
		seenFolders.add(key);
		return true;
	});

	return deduped;
}

export function searchFiles(userId, term = '', limit = 50) {
	const normalizedTerm = String(term || '').trim();
	if (!normalizedTerm) return [];

	const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
	const rows = db
		.prepare(`
      SELECT
        fm.*, ca.provider, ca.email
      FROM file_metadata fm
      INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
			WHERE fm.user_id = ?
				AND ca.status = 'active'
				AND fm.file_name LIKE ? COLLATE NOCASE
      ORDER BY
				CASE WHEN fm.file_name LIKE ? COLLATE NOCASE THEN 0 ELSE 1 END,
				fm.is_folder DESC,
				COALESCE(fm.remote_created_time, fm.created_at) DESC,
				fm.file_name COLLATE NOCASE ASC
			LIMIT ?
    `)
		.all(userId, `%${normalizedTerm}%`, `${normalizedTerm}%`, safeLimit);

	return buildDisplayNames(rows);
}

export function createFileMetadata(record) {
	const payload = {
		id: randomUUID(),
		user_id: record.user_id,
		virtual_path: normalizePath(record.virtual_path),
		file_name: record.file_name,
		is_folder: record.is_folder ? 1 : 0,
		size: record.size,
		mime_type: resolveMimeType(record),
		cloud_account_id: record.cloud_account_id,
		remote_file_id: record.remote_file_id,
		remote_parent_id: record.remote_parent_id || null,
		remote_created_time: record.remote_created_time || null,
		remote_modified_time: record.remote_modified_time || null,
	};

	db.prepare(`
    INSERT INTO file_metadata (
			id, user_id, virtual_path, file_name, is_folder, size, mime_type,
			cloud_account_id, remote_file_id, remote_parent_id, remote_created_time, remote_modified_time
    ) VALUES (
			@id, @user_id, @virtual_path, @file_name, @is_folder, @size, @mime_type,
			@cloud_account_id, @remote_file_id, @remote_parent_id, @remote_created_time, @remote_modified_time
    )
  `).run(payload);

	return getFileById(payload.user_id, payload.id);
}

export function getFileById(userId, id) {
	const row = db
		.prepare(`
      SELECT fm.*, ca.provider, ca.email
      FROM file_metadata fm
      INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
			WHERE fm.user_id = ? AND fm.id = ? AND ca.status = 'active'
    `)
		.get(userId, id);

	if (!row) return row;
	return buildDisplayNames([row])[0];
}

export function getFileByRemoteId(userId, cloudAccountId, remoteFileId) {
	const row = db
		.prepare(`
      SELECT fm.*, ca.provider, ca.email
      FROM file_metadata fm
      INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
			WHERE fm.user_id = ? AND fm.cloud_account_id = ? AND fm.remote_file_id = ? AND ca.status = 'active'
    `)
		.get(userId, cloudAccountId, remoteFileId);

	if (!row) return row;
	return buildDisplayNames([row])[0];
}

export function listAllFiles(userId) {
	return db.prepare('SELECT * FROM file_metadata WHERE user_id = ?').all(userId);
}

export function listStarredFiles(userId) {
	const rows = db
		.prepare(`
			SELECT fm.*, ca.provider, ca.email
			FROM file_metadata fm
			INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
			WHERE fm.user_id = ? AND COALESCE(fm.is_starred, 0) = 1 AND ca.status = 'active'
			ORDER BY COALESCE(fm.remote_modified_time, fm.remote_created_time) DESC,
				fm.updated_at DESC,
				fm.file_name COLLATE NOCASE ASC
		`)
		.all(userId);

	return buildDisplayNames(rows);
}

export function listRecentFiles(userId) {
	const rows = db
		.prepare(`
			SELECT fm.*, ca.provider, ca.email
			FROM file_metadata fm
			INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
			WHERE fm.user_id = ?
				AND fm.is_folder = 0
				AND ca.status = 'active'
			ORDER BY COALESCE(fm.remote_modified_time, fm.remote_created_time) DESC,
				fm.updated_at DESC,
				fm.file_name COLLATE NOCASE ASC
		`)
		.all(userId);

	return buildDisplayNames(rows);
}

export function updateFileStarredByRemoteId(userId, cloudAccountId, remoteFileId, isStarred) {
	return db.prepare(`
		UPDATE file_metadata
		SET is_starred = ?, updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ? AND cloud_account_id = ? AND remote_file_id = ?
	`).run(isStarred ? 1 : 0, userId, cloudAccountId, remoteFileId);
}

export function setFileStarred(userId, fileId, isStarred) {
	return db.prepare(`
		UPDATE file_metadata
		SET is_starred = ?, updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ? AND id = ?
	`).run(isStarred ? 1 : 0, userId, fileId);
}

export function replaceFilesForAccount(userId, cloudAccountId, records) {
	const normalizedRecords = records.map((record) => ({
		id: record.id || randomUUID(),
		user_id: userId,
		virtual_path: normalizePath(record.virtual_path),
		file_name: record.file_name,
		is_folder: record.is_folder ? 1 : 0,
		is_starred: record.is_starred ? 1 : 0,
		size: Number(record.size || 0),
		mime_type: resolveMimeType(record),
		cloud_account_id: cloudAccountId,
		remote_file_id: record.remote_file_id,
		remote_parent_id: record.remote_parent_id || null,
		remote_created_time: record.remote_created_time || null,
		remote_modified_time: record.remote_modified_time || null,
	}));

	const replace = db.transaction(() => {
		db.prepare('DELETE FROM file_metadata WHERE user_id = ? AND cloud_account_id = ?').run(userId, cloudAccountId);

		if (!normalizedRecords.length) {
			return;
		}

		const insert = db.prepare(`
      INSERT INTO file_metadata (
				id, user_id, virtual_path, file_name, is_folder, is_starred, size, mime_type,
				cloud_account_id, remote_file_id, remote_parent_id, remote_created_time, remote_modified_time
      ) VALUES (
				@id, @user_id, @virtual_path, @file_name, @is_folder, @is_starred, @size, @mime_type,
				@cloud_account_id, @remote_file_id, @remote_parent_id, @remote_created_time, @remote_modified_time
      )
    `);

		normalizedRecords.forEach((record) => insert.run(record));
	});

	replace();
}

export function clearFilesForAccount(userId, cloudAccountId) {
	db.prepare('DELETE FROM file_metadata WHERE user_id = ? AND cloud_account_id = ?').run(userId, cloudAccountId);
}

export function upsertFileMetadata(record) {
	db.prepare(`
    INSERT INTO file_metadata (
			id, user_id, virtual_path, file_name, is_folder, is_starred, size, mime_type,
			cloud_account_id, remote_file_id, remote_parent_id, remote_created_time, remote_modified_time
    ) VALUES (
			@id, @user_id, @virtual_path, @file_name, @is_folder, @is_starred, @size, @mime_type,
			@cloud_account_id, @remote_file_id, @remote_parent_id, @remote_created_time, @remote_modified_time
    )
    ON CONFLICT(id) DO UPDATE SET
			user_id = excluded.user_id,
      virtual_path = excluded.virtual_path,
      file_name = excluded.file_name,
      is_folder = excluded.is_folder,
			is_starred = excluded.is_starred,
      size = excluded.size,
      mime_type = excluded.mime_type,
      cloud_account_id = excluded.cloud_account_id,
      remote_file_id = excluded.remote_file_id,
      remote_parent_id = excluded.remote_parent_id,
	  remote_created_time = excluded.remote_created_time,
	  remote_modified_time = excluded.remote_modified_time,
      updated_at = CURRENT_TIMESTAMP
  `).run({
		...record,
		virtual_path: normalizePath(record.virtual_path),
		user_id: record.user_id,
		is_folder: record.is_folder ? 1 : 0,
		is_starred: record.is_starred ? 1 : 0,
	});
}

export function listDirectoryTree(userId) {
	return db
		.prepare(`
      SELECT id, virtual_path, file_name, is_folder, cloud_account_id
      FROM file_metadata
      WHERE user_id = ?
      ORDER BY virtual_path, is_folder DESC, file_name
    `)
		.all(userId);
}

// Update optimistic baris top-level setelah move akun-sama.
// remote_file_id memakai COALESCE: hanya diganti bila adapter mengembalikan id baru.
export function relocateFileMetadata(userId, fileId, { virtual_path, remote_parent_id, remote_file_id } = {}) {
	return db.prepare(`
		UPDATE file_metadata
		SET virtual_path = @virtual_path,
			remote_parent_id = @remote_parent_id,
			remote_file_id = COALESCE(@remote_file_id, remote_file_id),
			updated_at = CURRENT_TIMESTAMP
		WHERE user_id = @user_id AND id = @id
	`).run({
		user_id: userId,
		id: fileId,
		virtual_path: normalizePath(virtual_path),
		remote_parent_id: remote_parent_id ?? null,
		remote_file_id: remote_file_id ?? null,
	});
}

// Hapus satu baris metadata (dipakai engine Transfer setelah dest sukses pada mode move).
export function deleteFileMetadataById(userId, fileId) {
	return db
		.prepare('DELETE FROM file_metadata WHERE user_id = ? AND id = ?')
		.run(userId, fileId);
}

// Semua descendant (file + folder) di bawah `contentsVirtualPath` pada satu akun.
// Urut path length ASC → folder parent selalu sebelum anaknya (dipakai engine
// Transfer folder rekursif untuk membangun struktur dest top-down).
export function listSubtree(userId, cloudAccountId, contentsVirtualPath) {
	const prefix = normalizePath(contentsVirtualPath);
	const likePrefix = `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

	const rows = db
		.prepare(`
      SELECT fm.*, ca.provider, ca.email
      FROM file_metadata fm
      INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
      WHERE fm.user_id = ? AND fm.cloud_account_id = ? AND ca.status = 'active'
        AND fm.virtual_path LIKE ? ESCAPE '\\'
      ORDER BY LENGTH(fm.virtual_path) ASC, fm.file_name ASC
    `)
		.all(userId, cloudAccountId, likePrefix);

	return buildDisplayNames(rows);
}

// Cari baris folder yang ISI-nya berada di `contentsVirtualPath` (mis. "/Documents/")
// pada akun tertentu. Baris folder itu sendiri ada di parent path dengan file_name = nama folder.
// Mengembalikan null untuk root ("/") karena root bukan baris folder.
export function findFolderRowByPath(userId, cloudAccountId, contentsVirtualPath) {
	const normalized = normalizePath(contentsVirtualPath);
	if (normalized === '/') return null;

	const trimmed = normalized.replace(/\/+$/g, '');
	const lastSlash = trimmed.lastIndexOf('/');
	const name = trimmed.slice(lastSlash + 1);
	const parent = normalizePath(trimmed.slice(0, lastSlash + 1) || '/');

	const row = db
		.prepare(`
			SELECT fm.*, ca.provider, ca.email
			FROM file_metadata fm
			INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
			WHERE fm.user_id = ?
				AND fm.cloud_account_id = ?
				AND fm.is_folder = 1
				AND fm.file_name = ? COLLATE NOCASE
				AND fm.virtual_path = ?
				AND ca.status = 'active'
		`)
		.get(userId, cloudAccountId, name, parent);

	if (!row) return null;
	return buildDisplayNames([row])[0];
}

export function findFoldersByNameAndPath(userId, fileName, virtualPath) {
	const normalized = normalizePath(virtualPath);
	const rows = db
		.prepare(`
      SELECT fm.*, ca.provider, ca.email
      FROM file_metadata fm
      INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
      WHERE fm.user_id = ?
        AND fm.is_folder = 1
        AND fm.file_name = ? COLLATE NOCASE
        AND fm.virtual_path = ?
        AND ca.status = 'active'
    `)
		.all(userId, fileName, normalized);

	return buildDisplayNames(rows);
}