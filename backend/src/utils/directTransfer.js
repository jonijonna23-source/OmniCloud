export function supportsDirectDownload(provider) {
	return ['google_drive', 'onedrive', 'dropbox'].includes(provider);
}

export function supportsDirectUpload(provider, sizeBytes) {
	const threshold = (Number(process.env.DIRECT_TRANSFER_THRESHOLD_MB) || 50) * 1024 * 1024;
	
	return (
		['google_drive', 'onedrive', 'dropbox'].includes(provider) &&
		sizeBytes > threshold
	);
}
