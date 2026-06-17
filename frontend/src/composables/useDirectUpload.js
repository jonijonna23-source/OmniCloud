const CHUNK_SIZE_BYTES = 10 * 1024 * 1024; // 10MB chunk size
const MAX_RETRIES = 3;

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useDirectUpload() {
	async function uploadFileDirect({ uploadUrl, file, onProgress, signal }) {
		return new Promise((resolve, reject) => {
			if (!uploadUrl) {
				return reject(new Error('uploadUrl is required'));
			}

			if (signal?.aborted) {
				return reject(new DOMException('Upload cancelled', 'AbortError'));
			}

			const totalSize = file.size;
			let startBytes = 0;
			let endBytes = Math.min(CHUNK_SIZE_BYTES, totalSize);

			const uploadChunk = async (chunkStart, chunkEnd, attempt = 1) => {
				if (signal?.aborted) {
					return reject(new DOMException('Upload cancelled', 'AbortError'));
				}

				const chunk = file.slice(chunkStart, chunkEnd);
				const xhr = new XMLHttpRequest();

				const onAbort = () => {
					xhr.abort();
					reject(new DOMException('Upload cancelled', 'AbortError'));
				};
				if (signal) {
					signal.addEventListener('abort', onAbort);
				}

				xhr.open('PUT', uploadUrl);
				
				// Standard headers for resumable uploads (e.g. Google Drive/OneDrive)
				xhr.setRequestHeader('Content-Range', `bytes ${chunkStart}-${chunkEnd - 1}/${totalSize}`);
				
				xhr.upload.onprogress = (event) => {
					if (event.lengthComputable && onProgress) {
						const loadedSoFar = chunkStart + event.loaded;
						const percent = Math.min(99, Math.round((loadedSoFar / totalSize) * 100));
						onProgress(percent);
					}
				};

				xhr.onload = async () => {
					if (signal) {
						signal.removeEventListener('abort', onAbort);
					}

					// 200, 201, 202 are success codes. 308 is Resume Incomplete (Google Drive)
					if (xhr.status >= 200 && xhr.status < 300) {
						// Final chunk completed
						if (chunkEnd >= totalSize) {
							if (onProgress) onProgress(100);
							try {
								const responsePayload = JSON.parse(xhr.responseText);
								return resolve(responsePayload);
							} catch (e) {
								return resolve({ url: uploadUrl }); // fallback
							}
						}
						// Continue with next chunk
						startBytes = chunkEnd;
						endBytes = Math.min(startBytes + CHUNK_SIZE_BYTES, totalSize);
						uploadChunk(startBytes, endBytes);
					} else if (xhr.status === 308) {
						// Google Drive signals incomplete, continue
						startBytes = chunkEnd;
						endBytes = Math.min(startBytes + CHUNK_SIZE_BYTES, totalSize);
						uploadChunk(startBytes, endBytes);
					} else {
						// Error that might be retriable
						handleChunkError(xhr.status, chunkStart, chunkEnd, attempt);
					}
				};

				xhr.onerror = () => {
					if (signal) {
						signal.removeEventListener('abort', onAbort);
					}
					handleChunkError(0, chunkStart, chunkEnd, attempt);
				};
				
				xhr.ontimeout = () => {
					if (signal) {
						signal.removeEventListener('abort', onAbort);
					}
					handleChunkError(0, chunkStart, chunkEnd, attempt); // 0 acts like timeout/network error
				};

				xhr.send(chunk);
			};

			const handleChunkError = async (status, chunkStart, chunkEnd, attempt) => {
				const isRetriable = status === 0 || status === 429 || (status >= 500 && status <= 504);
				if (isRetriable && attempt <= MAX_RETRIES) {
					const backoffTime = attempt === 1 ? 1000 : attempt === 2 ? 2000 : 4000;
					await delay(backoffTime);
					uploadChunk(chunkStart, chunkEnd, attempt + 1);
				} else {
					reject(new Error(`Direct upload failed with status ${status}`));
				}
			};

			uploadChunk(startBytes, endBytes);
		});
	}

	return { uploadFileDirect };
}
