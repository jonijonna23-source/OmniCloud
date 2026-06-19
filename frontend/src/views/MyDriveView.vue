<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { IconChevronRight, IconFolder } from '@tabler/icons-vue';
import DriveShell from '../components/DriveShell.vue';
import FloatingProgressToast from '../components/FloatingProgressToast.vue';
import FileListFilterBar from '../components/FileListFilterBar.vue';
import FileListSelectionBar from '../components/FileListSelectionBar.vue';
import FileListViewModeToggle from '../components/FileListViewModeToggle.vue';
import FileListHeader from '../components/FileListHeader.vue';
import FileListRow from '../components/FileListRow.vue';
import FileListGridCard from '../components/FileListGridCard.vue';
import FileListContextMenu from '../components/FileListContextMenu.vue';
import FilePreviewModal from '../components/FilePreviewModal.vue';
import FileDetailsModal from '../components/FileDetailsModal.vue';
import FolderPickerModal from '../components/FolderPickerModal.vue';
import LoadingState from '../components/LoadingState.vue';
import { useIncrementalRender } from '../composables/useIncrementalRender';
import { useFileListView } from '../composables/useFileListView';
import { useAutoRefresh } from '../composables/useAutoRefresh.js';
import { useTrackedFileActions } from '../composables/useTrackedFileActions.js';
import { providerLabel } from '../composables/useFormatFile.js';
import { useFileTreeStore } from '../stores/fileTree';
import { useUploadQueueStore } from '../stores/uploadQueue';
import { useAccountManagementStore } from '../stores/accountManagement';
import { api } from '../services/api';

const { t } = useI18n();

const fileTreeStore = useFileTreeStore();
const uploadQueueStore = useUploadQueueStore();
const accountStore = useAccountManagementStore();
const { currentPath, breadcrumbs, searchTerm, isLoading } = storeToRefs(fileTreeStore);
const { uploads, totalProgress } = storeToRefs(uploadQueueStore);
const { accounts } = storeToRefs(accountStore);

const isDragActive = ref(false);
const dragDepth = ref(0);
const fileInputRef = ref(null);
const folderInputRef = ref(null);
const lastObservedSyncAt = ref('');
const highlightedFileId = ref(null);
const highlightTimeout = ref(null);
const selectedUploadAccount = ref('auto');
const dropHoverPath = ref(null);

const fileActions = useTrackedFileActions({ uploadQueueStore, api });

const view = useFileListView({
	sourceFiles: computed(() => fileTreeStore.filteredFiles),
	loadFiles: () => fileTreeStore.loadFiles(fileTreeStore.currentPath).then(() => fileTreeStore.files),
	uploadQueueStore,
	autoRefresh: false,
	sortable: true,
	initialSortBy: 'updated_at',
	initialSortDirection: 'desc',
	actions: fileActions,
});

const {
	sortedFiles,
	isGridView,
	activeFilterMenu,
	selectedTypeFilter,
	selectedOwnerFilter,
	selectedUpdatedFilter,
	typeOptions,
	ownerOptions,
	updatedOptions,
	sortBy,
	sortDirection,
	setSort,
	toggleFilterMenu,
	applyFilter,
	clearFilter,
	selectedCount,
	primarySelectedFile,
	isSelected,
	openContextMenu,
	clearSelection,
	selectItem,
	canDownloadSelection,
	canRenameSelection,
	canToggleStarSelection,
	isPrimarySelectedStarred,
	canOpenSelection,
	canPreviewSelection,
	canMoveSelection,
	canCopySelection,
	isFolderPickerOpen,
	folderPickerMode,
	folderPickerFiles,
	folderPickerTitle,
	folderPickerActionLabel,
	openMoveModal,
	openCopyModal,
	closeFolderPicker,
	getActionFiles,
	canPreview,
	previewFile,
	isPreviewOpen,
	isPreviewLoading,
	openPreview,
	closePreview,
	handlePreviewLoaded,
	handlePreviewFailed,
	detailsFile,
	isDetailsOpen,
	closeDetails,
	downloadSelection,
	renameSelectedFile,
	deleteSelectedFile,
	toggleSelectedFileStar,
	showSelectedFileDetails,
	contextMenu,
	contextMenuRef,
	closeContextMenu,
	actionInProgress,
	actionLabel,
} = view;

const { renderCount, visibleItems: renderedFiles, handleScroll: handleListScroll } = useIncrementalRender(view.sortedFiles, {
	initialCount: 80,
	step: 80,
	threshold: 240,
});

watch(searchTerm, (term) => {
	fileTreeStore.applySearch(term);
});

watch(() => fileTreeStore.files, consumePendingHighlight, { flush: 'post' });

function clearHighlightTimer() {
	if (!highlightTimeout.value) return;
	window.clearTimeout(highlightTimeout.value);
	highlightTimeout.value = null;
}

function hasHighlightedFile(targetId) {
	return Boolean(targetId) && fileTreeStore.files.some((file) => file.id === targetId);
}

function ensureHighlightedFileRendered(targetId) {
	const targetIndex = sortedFiles.value.findIndex((file) => file.id === targetId);
	if (targetIndex >= renderCount.value) {
		renderCount.value = targetIndex + 1;
	}
}

function scrollToFile(targetId) {
	document.querySelector(`[data-file-id="${CSS.escape(targetId)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function scheduleHighlightClear(targetId) {
	clearHighlightTimer();
	highlightTimeout.value = window.setTimeout(() => {
		if (highlightedFileId.value === targetId) {
			highlightedFileId.value = null;
		}
		highlightTimeout.value = null;
	}, 2400);
}

async function consumePendingHighlight() {
	const targetId = fileTreeStore.pendingHighlightId;
	if (!hasHighlightedFile(targetId)) return;

	fileTreeStore.pendingHighlightId = null;
	ensureHighlightedFileRendered(targetId);
	highlightedFileId.value = targetId;
	scheduleHighlightClear(targetId);

	await nextTick();
	scrollToFile(targetId);
}

function openItemOnDoubleClick(file) {
	if (file.is_folder) {
		openFolder(file);
		return;
	}
	if (canPreview(file)) {
		openPreview(file);
	}
}

function openFolder(file) {
	if (!file.is_folder) return;
	clearSelection();
	const basePath = file.virtual_path || (currentPath.value === '/' ? '/' : `${currentPath.value}/`);
	const nextPath = `${basePath}${file.file_name}/`;
	fileTreeStore.navigate(nextPath.startsWith('/') ? nextPath : `/${nextPath}`);
}

function openSelectedItem() {
	const file = primarySelectedFile.value || contextMenu.value.file;
	closeContextMenu();
	if (file?.is_folder) openFolder(file);
}

function resetFileInput(inputRef) {
	if (inputRef.value) inputRef.value.value = '';
}

async function refreshCurrentFolder() {
	await fileTreeStore.loadFiles(currentPath.value);
}

async function checkSyncStatus() {
	if (document.visibilityState !== 'visible') return;
	try {
		const { sync } = await api.getHealth();
		const nextSyncAt = sync?.lastRunAt || '';
		if (!lastObservedSyncAt.value) {
			lastObservedSyncAt.value = nextSyncAt;
			return;
		}
		if (nextSyncAt && nextSyncAt !== lastObservedSyncAt.value) {
			lastObservedSyncAt.value = nextSyncAt;
			await refreshCurrentFolder();
		}
	} catch {
	}
}

useAutoRefresh(checkSyncStatus, { intervalMs: 20000, immediate: false });

async function handleUploads(entries) {
	if (!entries.length) return;
	try {
		await uploadQueueStore.uploadFiles(entries, currentPath.value, refreshCurrentFolder, selectedUploadAccount.value);
		await refreshCurrentFolder();
	} catch {
	}
}

async function handleFolderSelected(dest) {
	// Pakai snapshot saat modal dibuka (seleksi bisa sudah ke-clear).
	const targets = folderPickerFiles.value;
	console.log('[Move] handleFolderSelected', { dest, mode: folderPickerMode.value, targets: targets.length });
	if (!targets.length) {
		console.warn('[Move] dibatalkan: snapshot file kosong');
		return;
	}

	try {
		await fileActions.moveOrCopyFiles(targets, dest, folderPickerMode.value);
		closeFolderPicker();
		clearSelection();
		await refreshCurrentFolder();
	} catch (err) {
		console.error('[Move] moveOrCopyFiles gagal', err);
	}
}

function onItemDragStart(event, item) {
	if (!isSelected(item)) {
		replaceSelection(item);
	}
	const targets = getActionFiles();
	event.dataTransfer.setData('omnicloud/items', JSON.stringify(targets));
	event.dataTransfer.effectAllowed = 'copyMove';
}

async function onItemDrop(event, destFolder) {
	// Hanya folder yang valid jadi drop target.
	if (!destFolder?.is_folder) return;
	event.stopPropagation();

	const data = event.dataTransfer.getData('omnicloud/items');
	if (!data) return;
	const targets = JSON.parse(data);
	if (!targets.length) return;

	// Cegah drop folder ke dirinya sendiri.
	if (targets.some((item) => item.id === destFolder.id)) return;

	const mode = event.altKey || event.ctrlKey || event.metaKey ? 'copy' : 'move';
	const destPath = (destFolder.virtual_path || (currentPath.value === '/' ? '/' : `${currentPath.value}/`)) + destFolder.file_name + '/';
	const dest = {
		virtual_path: destPath,
		cloud_account_id: destFolder.cloud_account_id,
		remote_parent_id: destFolder.remote_file_id,
	};

	try {
		await fileActions.moveOrCopyFiles(targets, dest, mode);
		clearSelection();
		await refreshCurrentFolder();
	} catch {}
}

function onBreadcrumbDragEnter(event, crumb) {
	if (!event.dataTransfer?.types?.includes('omnicloud/items')) return;
	dropHoverPath.value = crumb.path;
}

function onBreadcrumbDragOver(event) {
	if (!event.dataTransfer?.types?.includes('omnicloud/items')) return;
	event.dataTransfer.dropEffect = event.altKey || event.ctrlKey || event.metaKey ? 'copy' : 'move';
}

function onBreadcrumbDragLeave() {
	dropHoverPath.value = null;
}

async function onBreadcrumbDrop(event, crumb) {
	dropHoverPath.value = null;
	if (!event.dataTransfer?.types?.includes('omnicloud/items')) return;
	
	const data = event.dataTransfer.getData('omnicloud/items');
	if (!data) return;
	const targets = JSON.parse(data);
	if (!targets.length) return;
	
	const mode = event.altKey || event.ctrlKey || event.metaKey ? 'copy' : 'move';

	// Breadcrumb path ambigu lintas akun → relokasi tiap item DALAM akun-nya sendiri.
	// Group by source account agar tiap batch bawa cloud_account_id yang benar.
	const groups = new Map();
	for (const item of targets) {
		if (!groups.has(item.cloud_account_id)) groups.set(item.cloud_account_id, []);
		groups.get(item.cloud_account_id).push(item);
	}

	try {
		for (const [accountId, items] of groups) {
			await fileActions.moveOrCopyFiles(
				items,
				{ virtual_path: crumb.path, cloud_account_id: accountId },
				mode,
			);
		}
		clearSelection();
		await refreshCurrentFolder();
	} catch {}
}

function openFilePicker() {
	resetFileInput(fileInputRef);
	fileInputRef.value?.click();
}

function openFolderPicker() {
	resetFileInput(folderInputRef);
	folderInputRef.value?.click();
}

async function onFileInputChange(event) {
	const files = Array.from(event.target.files || []);
	await handleUploads(files);
}

async function onFolderInputChange(event) {
	const entries = Array.from(event.target.files || []).map((file) => ({
		file,
		relativePath: file.webkitRelativePath || file.name,
	}));
	await handleUploads(entries);
}

async function readDirectoryEntry(entry, prefix = '') {
	const reader = entry.createReader();
	const children = await new Promise((resolve, reject) => {
		reader.readEntries(resolve, reject);
	});
	const nested = await Promise.all(
		children.map((child) => readDroppedEntry(child, prefix ? `${prefix}/${entry.name}` : entry.name)),
	);
	return nested.flat();
}

async function readFileEntry(entry, prefix = '') {
	return new Promise((resolve, reject) => {
		entry.file(
			(file) => resolve([{ file, relativePath: prefix ? `${prefix}/${file.name}` : file.name }]),
			reject,
		);
	});
}

async function readDroppedEntry(entry, prefix = '') {
	if (entry.isDirectory) return readDirectoryEntry(entry, prefix);
	return readFileEntry(entry, prefix);
}

async function collectDroppedEntries(dataTransfer) {
	const items = Array.from(dataTransfer.items || []);
	const entries = items.map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
	if (!entries.length) return Array.from(dataTransfer.files || []);
	const collected = await Promise.all(entries.map((entry) => readDroppedEntry(entry)));
	return collected.flat();
}

function resetDragState() {
	dragDepth.value = 0;
	isDragActive.value = false;
}

function handleDragEnter(event) {
	if (event.dataTransfer?.types?.includes('omnicloud/items')) return;
	dragDepth.value += 1;
	isDragActive.value = true;
}

function handleDragLeave(event) {
	if (!event.currentTarget.contains(event.relatedTarget)) {
		resetDragState();
		return;
	}
	dragDepth.value = Math.max(0, dragDepth.value - 1);
	if (dragDepth.value === 0) isDragActive.value = false;
}

async function handleDrop(event) {
	resetDragState();
	const entries = await collectDroppedEntries(event.dataTransfer);
	await handleUploads(entries);
}

async function createNewFolder() {
	const folderName = window.prompt(t('drive.newFolderName'));
	if (!folderName?.trim()) return;
	try {
		await uploadQueueStore.trackServerOperation(
			{ type: 'create-folder', name: folderName.trim(), targetKind: 'folder' },
			() => api.createFolder({ name: folderName.trim(), virtual_path: currentPath.value }),
		);
		await refreshCurrentFolder();
	} catch {
	}
}

function handleVisibilityChange() {
	resetDragState();
	if (document.visibilityState === 'visible') {
		refreshCurrentFolder();
		checkSyncStatus();
	}
}

onMounted(async () => {
	const initialPath = fileTreeStore.pendingPath || '/';
	fileTreeStore.pendingPath = null;
	await fileTreeStore.loadFiles(initialPath);
	consumePendingHighlight();
	window.addEventListener('dragend', resetDragState);
	window.addEventListener('drop', resetDragState);
	window.addEventListener('blur', resetDragState);
	document.addEventListener('visibilitychange', handleVisibilityChange);
});

onBeforeUnmount(() => {
	clearHighlightTimer();
	window.removeEventListener('dragend', resetDragState);
	window.removeEventListener('drop', resetDragState);
	window.removeEventListener('blur', resetDragState);
	document.removeEventListener('visibilitychange', handleVisibilityChange);
});
</script>

<template>
	<DriveShell current-section="drive" @new-folder="createNewFolder" @upload-files="openFilePicker" @upload-folder="openFolderPicker">
		<div id="MyDriveView" class="relative min-h-[calc(100vh-84px)] scroll-mt-20 rounded-[24px] bg-white px-4 py-[18px] pb-5 text-[#202124] dark:bg-slate-800 dark:text-slate-100 sm:px-6" @click="clearSelection" @dragenter.prevent="handleDragEnter" @dragover.prevent="handleDragEnter" @dragleave.prevent="handleDragLeave" @drop.prevent="handleDrop">
			<input ref="fileInputRef" class="hidden" type="file" multiple @change="onFileInputChange" />
			<input ref="folderInputRef" class="hidden" type="file" multiple webkitdirectory directory @change="onFolderInputChange" />

			<div v-if="isDragActive" class="pointer-events-none absolute inset-4 z-20 grid place-items-center rounded-[24px] border-2 border-dashed border-[#1a73e8] bg-[#e8f0fe]/90 text-center dark:bg-slate-900/90">
				<div>
					<p class="text-lg font-semibold text-[#1a73e8]">Lepas file di sini untuk upload</p>
					<p class="mt-2 text-sm text-[#5f6368] dark:text-slate-400">File dan folder akan diunggah ke lokasi Drive saat ini.</p>
				</div>
			</div>

			<div class="mb-2 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
				<nav aria-label="Breadcrumb" class="m-0 flex flex-wrap items-center gap-1 text-2xl font-normal text-[#202124] dark:text-slate-100">
					<template v-for="(crumb, index) in breadcrumbs" :key="crumb.path">
						<button type="button" class="max-w-[220px] truncate rounded-md px-1.5 text-left transition hover:bg-black/[0.04] hover:text-[#1a73e8] dark:hover:bg-white/10 dark:hover:text-sky-300" :class="{ 'bg-blue-50/50 ring-2 ring-[#1a73e8] dark:bg-sky-900/20 dark:ring-sky-400': dropHoverPath === crumb.path }" @click="fileTreeStore.navigate(crumb.path)" @dragenter.prevent="e => onBreadcrumbDragEnter(e, crumb)" @dragover.prevent="onBreadcrumbDragOver" @dragleave="onBreadcrumbDragLeave" @drop.prevent="e => onBreadcrumbDrop(e, crumb)">{{ crumb.label === 'Root' ? 'Drive Saya' : crumb.label }}</button>
						<IconChevronRight v-if="index < breadcrumbs.length - 1" :size="18" :stroke="2" class="mx-0.5 text-[#5f6368] dark:text-slate-400" />
					</template>
				</nav>
				<FileListViewModeToggle v-model="isGridView" />
			</div>

			<div class="mb-3 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
				<FileListSelectionBar v-if="selectedCount" :selected-count="selectedCount" :can-preview="canPreviewSelection" :can-toggle-star="canToggleStarSelection" :is-primary-starred="isPrimarySelectedStarred" :can-download="canDownloadSelection" :can-rename="canRenameSelection" :can-move="canMoveSelection" :can-copy="canCopySelection" :primary-file="primarySelectedFile" @clear="clearSelection" @preview="openPreview" @toggle-star="toggleSelectedFileStar" @download="downloadSelection" @rename="renameSelectedFile" @move="openMoveModal" @copy="openCopyModal" @show-details="showSelectedFileDetails" @delete="deleteSelectedFile">
					<template #prefix="{ primary }">
						<button v-if="primary?.is_folder && selectedCount === 1" type="button" class="inline-flex size-9 items-center justify-center rounded-full transition enabled:hover:bg-[#d2e3fc] dark:enabled:hover:bg-sky-500/20" :title="t('common.open')" @click="openSelectedItem">
							<IconFolder :size="18" :stroke="2" />
						</button>
					</template>
				</FileListSelectionBar>
				<FileListFilterBar v-else :type-options="typeOptions" :owner-options="ownerOptions" :updated-options="updatedOptions" :selected-type-filter="selectedTypeFilter" :selected-owner-filter="selectedOwnerFilter" :selected-updated-filter="selectedUpdatedFilter" :active-filter-menu="activeFilterMenu" v-model:search-term="searchTerm" :target-account-options="accounts" v-model:selected-target-account="selectedUploadAccount" @toggle-filter-menu="toggleFilterMenu" @apply-filter="applyFilter" @clear-filter="clearFilter" />
			</div>

			<div v-if="!isGridView" class="relative">
				<div class="custom-scrollbar overflow-x-auto rounded-2xl border border-[#e0e3e7] bg-white dark:border-slate-700 dark:bg-slate-800">
					<div class="min-w-[760px]">
						<div class="custom-scrollbar max-h-[min(70vh,780px)] overflow-y-auto overflow-x-hidden" @scroll="handleListScroll">
							<FileListHeader :sortable="true" :sort-by="sortBy" :sort-direction="sortDirection" @sort="setSort" />

							<FileListRow v-for="item in renderedFiles" :key="item.id" :item="item" :selected="isSelected(item)" :highlighted="highlightedFileId === item.id" name-field="display_name" @select="(event) => selectItem(event, item)" @open="openItemOnDoubleClick(item)" @contextmenu="(event) => openContextMenu(event, item)" @dragstart="(event) => onItemDragStart(event, item)" @drop="(event) => onItemDrop(event, item)" />
							<div v-if="!sortedFiles.length && !isLoading" class="p-[18px] text-[#5f6368] dark:text-slate-400">{{ t('drive.noFiles') }}</div>
							<div v-if="isLoading" class="p-[18px]">
								<LoadingState />
							</div>
						</div>
					</div>
				</div>
				<LoadingState v-if="actionInProgress" variant="overlay" :message="actionLabel || t('drive.processing')" />
			</div>

			<div v-else class="relative">
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
					<FileListGridCard v-for="item in renderedFiles" :key="item.id" :item="item" :selected="isSelected(item)" :highlighted="highlightedFileId === item.id" name-field="display_name" @select="(event) => selectItem(event, item)" @open="openItemOnDoubleClick(item)" @contextmenu="(event) => openContextMenu(event, item)" @dragstart="(event) => onItemDragStart(event, item)" @drop="(event) => onItemDrop(event, item)" />
					<div v-if="!sortedFiles.length && !isLoading" class="col-span-full rounded-2xl border border-dashed border-[#dadce0] bg-white px-5 py-8 text-center text-[#5f6368] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">{{ t('drive.noFiles') }}</div>
					<div v-if="isLoading" class="col-span-full rounded-2xl border border-dashed border-[#dadce0] bg-white px-5 py-8 text-center text-[#5f6368] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
						<LoadingState />
					</div>
				</div>
				<LoadingState v-if="actionInProgress" variant="overlay" :message="actionLabel || t('drive.processing')" />
			</div>

			<FileListContextMenu :context-menu-ref="contextMenuRef" :context-menu="contextMenu" :selected-count="selectedCount" :primary-selected-file="primarySelectedFile" :can-preview="canPreviewSelection" :can-toggle-star="canToggleStarSelection" :is-primary-starred="isPrimarySelectedStarred" :can-download="canDownloadSelection" :can-rename="canRenameSelection" :can-move="canMoveSelection" :can-copy="canCopySelection" :can-show-details="selectedCount === 1" :can-open-folder="canOpenSelection" @open-folder="openSelectedItem" @preview="openPreview" @toggle-star="toggleSelectedFileStar" @download="downloadSelection" @rename="renameSelectedFile" @move="openMoveModal" @copy="openCopyModal" @show-details="showSelectedFileDetails" @delete="deleteSelectedFile" @close="closeContextMenu" />

			<FileDetailsModal :file="detailsFile" :is-open="isDetailsOpen" :is-folder="detailsFile?.is_folder" :provider-label-fn="providerLabel" @close="closeDetails" />
			<FilePreviewModal :file="previewFile" :is-open="isPreviewOpen" :is-loading="isPreviewLoading" @close="closePreview" @loaded="handlePreviewLoaded" @failed="handlePreviewFailed" />
			<FolderPickerModal :is-open="isFolderPickerOpen" :title="folderPickerTitle" :action-label="folderPickerActionLabel" @close="closeFolderPicker" @select="handleFolderSelected" />
		</div>

		<FloatingProgressToast :uploads="uploads" :total-progress="totalProgress" @close="uploadQueueStore.clearOperations" @close-item="uploadQueueStore.closeOperation" />
	</DriveShell>
</template>
