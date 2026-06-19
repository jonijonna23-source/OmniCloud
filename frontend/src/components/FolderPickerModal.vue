<script setup>
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconX, IconChevronRight, IconFolder, IconArrowLeft } from '@tabler/icons-vue';
import { api } from '../services/api';
import LoadingState from './LoadingState.vue';
import TruncateMarquee from './TruncateMarquee.vue';
import { providerIcon } from '../composables/useFormatFile.js';

const { t } = useI18n();

const props = defineProps({
	isOpen: { type: Boolean, default: false },
	title: { type: String, default: 'Pilih Folder' },
	actionLabel: { type: String, default: 'Pilih' },
});

const emit = defineEmits(['close', 'select']);

// View gabungan multi-akun → path saja ambigu. Picker scope per-akun:
// root = daftar akun; setelah pilih akun, navigasi folder DI DALAM akun itu.
const accounts = ref([]);
const selectedAccount = ref(null);
const currentPath = ref('/');
const currentRemoteParentId = ref(null);
// Tiap crumb simpan { label, path, remoteParentId } agar navigate-up pulihkan konteks.
const breadcrumbs = ref([]);
const folders = ref([]);
const isLoading = ref(false);
const error = ref('');

function resetState() {
	accounts.value = [];
	selectedAccount.value = null;
	currentPath.value = '/';
	currentRemoteParentId.value = null;
	breadcrumbs.value = [];
	folders.value = [];
	error.value = '';
}

async function loadAccounts() {
	isLoading.value = true;
	error.value = '';
	try {
		const { data } = await api.listAccounts();
		accounts.value = (data || []).filter((account) => account.status === 'active');
	} catch (err) {
		error.value = err.message || 'Gagal memuat akun';
	} finally {
		isLoading.value = false;
	}
}

async function loadFolders(path) {
	if (!selectedAccount.value) return;
	isLoading.value = true;
	error.value = '';
	try {
		// Scoped per-akun (backend skip dedup) → subfolder akun terpilih utuh.
		const { data } = await api.listFiles(path, selectedAccount.value.id);
		folders.value = (data || []).filter((file) => file.is_folder);
		currentPath.value = path;
		console.log('[FolderPicker] loadFolders', { path, account: selectedAccount.value.id, folders: folders.value.length });
	} catch (err) {
		error.value = err.message || 'Gagal memuat folder';
	} finally {
		isLoading.value = false;
	}
}

function accountLabel(account) {
	return account.email || account.provider;
}

function selectAccount(account) {
	selectedAccount.value = account;
	currentPath.value = '/';
	currentRemoteParentId.value = null;
	breadcrumbs.value = [{ label: accountLabel(account), path: '/', remoteParentId: null }];
	loadFolders('/');
}

function enterFolder(folder) {
	const contentsPath = (folder.virtual_path || currentPath.value) + folder.file_name + '/';
	currentRemoteParentId.value = folder.remote_file_id || null;
	breadcrumbs.value.push({
		label: folder.display_name || folder.file_name,
		path: contentsPath,
		remoteParentId: folder.remote_file_id || null,
	});
	loadFolders(contentsPath);
}

function navigateToCrumb(index) {
	const crumb = breadcrumbs.value[index];
	breadcrumbs.value = breadcrumbs.value.slice(0, index + 1);
	currentRemoteParentId.value = crumb.remoteParentId;
	loadFolders(crumb.path);
}

function navigateBack() {
	if (breadcrumbs.value.length > 1) {
		navigateToCrumb(breadcrumbs.value.length - 2);
	} else {
		// Di root akun → kembali ke daftar akun.
		selectedAccount.value = null;
		breadcrumbs.value = [];
		folders.value = [];
		currentPath.value = '/';
		currentRemoteParentId.value = null;
	}
}

watch(
	() => props.isOpen,
	(open) => {
		if (open) {
			resetState();
			loadAccounts();
		} else {
			resetState();
		}
	},
);

function handleConfirm() {
	if (!selectedAccount.value) {
		error.value = 'Pilih akun tujuan';
		console.warn('[FolderPicker] handleConfirm dibatalkan: belum pilih akun');
		return;
	}

	const dest = {
		cloud_account_id: selectedAccount.value.id,
		virtual_path: currentPath.value,
		remote_parent_id: currentRemoteParentId.value,
	};
	console.log('[FolderPicker] handleConfirm → emit select', dest);
	emit('select', dest);
}
</script>

<template>
	<div v-if="isOpen" class="fixed inset-0 z-[100] grid place-items-center bg-slate-900/40 px-4 backdrop-blur-sm dark:bg-slate-900/60" @click="emit('close')">
		<div class="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-[24px] bg-white shadow-[0_24px_48px_rgba(0,0,0,0.2)] dark:bg-slate-800" @click.stop>
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-[#e0e3e7] px-6 py-4 dark:border-slate-700">
				<h3 class="text-xl font-semibold text-[#202124] dark:text-slate-100">{{ title }}</h3>
				<button type="button" class="grid size-9 place-items-center rounded-full text-[#5f6368] transition hover:bg-[#f1f3f4] dark:text-slate-400 dark:hover:bg-slate-700" @click="emit('close')">
					<IconX :size="20" :stroke="2" />
				</button>
			</div>

			<!-- Breadcrumb & Navigation (hanya saat akun terpilih) -->
			<div v-if="selectedAccount" class="flex items-center gap-2 border-b border-[#e0e3e7] bg-[#f8fafd] px-4 py-3 dark:border-slate-700 dark:bg-slate-900/50">
				<button type="button" class="grid size-8 shrink-0 place-items-center rounded-full text-[#5f6368] transition hover:bg-[#e8eaed] dark:text-slate-400 dark:hover:bg-slate-800" @click="navigateBack">
					<IconArrowLeft :size="18" :stroke="2" />
				</button>
				<div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm text-[#202124] dark:text-slate-200">
					<template v-for="(crumb, index) in breadcrumbs" :key="crumb.path">
						<button type="button" class="max-w-[150px] shrink-0 truncate rounded-md px-2 py-1 transition hover:bg-[#e8eaed] dark:hover:bg-slate-800" @click="navigateToCrumb(index)">
							{{ crumb.label }}
						</button>
						<IconChevronRight v-if="index < breadcrumbs.length - 1" :size="16" class="shrink-0 text-[#5f6368] dark:text-slate-500" />
					</template>
				</div>
			</div>

			<!-- List: akun (root) atau folder -->
			<div class="custom-scrollbar relative flex-1 overflow-y-auto p-2 min-h-[300px]">
				<LoadingState v-if="isLoading" class="mt-8" />

				<!-- Daftar akun -->
				<template v-else-if="!selectedAccount">
					<template v-if="accounts.length > 0">
						<button v-for="account in accounts" :key="account.id" type="button" class="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition hover:bg-[#f1f3f4] dark:hover:bg-slate-700/50" @click="selectAccount(account)">
							<div class="grid size-10 shrink-0 place-items-center rounded-lg bg-white dark:bg-slate-900/70 shadow-sm border border-[#e0e3e7] dark:border-slate-600">
								<img v-if="providerIcon(account.provider)" :src="providerIcon(account.provider)" class="size-5 object-contain" />
								<IconFolder v-else :size="20" :stroke="2" />
							</div>
							<div class="min-w-0 flex-1">
								<TruncateMarquee as="p" class="text-sm font-medium text-[#202124] dark:text-slate-100" :text="accountLabel(account)" />
							</div>
							<IconChevronRight :size="18" class="shrink-0 text-[#5f6368] dark:text-slate-500" />
						</button>
					</template>
					<div v-else class="flex h-full flex-col items-center justify-center text-center text-[#5f6368] dark:text-slate-400 mt-12">
						<IconFolder :size="48" :stroke="1" class="mb-3 opacity-50" />
						<p>Tidak ada akun aktif</p>
					</div>
				</template>

				<!-- Daftar folder dalam akun -->
				<template v-else-if="folders.length > 0">
					<button v-for="folder in folders" :key="folder.id" type="button" class="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition hover:bg-[#f1f3f4] dark:hover:bg-slate-700/50" @click="enterFolder(folder)">
						<div class="grid size-10 shrink-0 place-items-center rounded-lg bg-[#e8f0fe] text-[#1a73e8] dark:bg-sky-500/20 dark:text-sky-300">
							<IconFolder :size="20" :stroke="2" />
						</div>
						<div class="min-w-0 flex-1">
							<TruncateMarquee as="p" class="text-sm font-medium text-[#202124] dark:text-slate-100" :text="folder.display_name || folder.file_name" />
						</div>
					</button>
				</template>

				<div v-else class="flex h-full flex-col items-center justify-center text-center text-[#5f6368] dark:text-slate-400 mt-12">
					<IconFolder :size="48" :stroke="1" class="mb-3 opacity-50" />
					<p>Folder ini kosong</p>
				</div>
			</div>

			<!-- Footer -->
			<div class="border-t border-[#e0e3e7] bg-[#f8fafd] px-6 py-4 dark:border-slate-700 dark:bg-slate-900/50">
				<p v-if="error" class="mb-3 text-sm text-red-600 dark:text-red-400">{{ error }}</p>
				<div class="flex items-center justify-between gap-3">
					<p v-if="selectedAccount" class="min-w-0 truncate text-xs text-[#5f6368] dark:text-slate-400">
						Tujuan: {{ accountLabel(selectedAccount) }}{{ currentPath === '/' ? '' : currentPath }}
					</p>
					<span v-else />
					<div class="flex shrink-0 justify-end gap-3">
						<button type="button" class="rounded-full px-6 py-2.5 text-sm font-medium text-[#5f6368] transition hover:bg-[#f1f3f4] dark:text-slate-300 dark:hover:bg-slate-700" @click="emit('close')">Batal</button>
						<button type="button" class="rounded-full bg-[#1a73e8] px-6 py-2.5 text-sm font-medium text-white transition hover:bg-[#1557b0] disabled:opacity-50 dark:bg-sky-600 dark:hover:bg-sky-500" :disabled="!selectedAccount || isLoading" @click="handleConfirm">
							{{ actionLabel }}
						</button>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>
