<script setup>
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useFileTreeStore } from '../stores/fileTree';
import { useUploadQueueStore } from '../stores/uploadQueue';
import { useAccountManagementStore } from '../stores/accountManagement';
import { api } from '../services/api';
import StatsCard from '../components/StatsCard.vue';
import StorageAccountsPanel from '../components/StorageAccountsPanel.vue';
import UploadDropzone from '../components/UploadDropzone.vue';
import FileExplorer from '../components/FileExplorer.vue';
import FloatingProgressToast from '../components/FloatingProgressToast.vue';

const fileTreeStore = useFileTreeStore();
const uploadQueueStore = useUploadQueueStore();
const accountStore = useAccountManagementStore();

const { currentPath, filteredFiles, breadcrumbs, searchTerm, isLoading, error } = storeToRefs(fileTreeStore);
const { accounts } = storeToRefs(accountStore);
const { uploads, totalProgress } = storeToRefs(uploadQueueStore);

const health = ref(null);

const stats = computed(() => {
	const totalAccounts = accounts.value.length;
	const activeAccountsCount = accounts.value.filter((account) => account.status === 'active').length;
	const totalFreeSpace = accounts.value.reduce((sum, account) => sum + Number(account.free_space || 0), 0);

	return [
		{ label: 'Active providers', value: activeAccountsCount, hint: `${totalAccounts} linked accounts` },
		{ label: 'Current virtual path', value: currentPath.value, hint: `${filteredFiles.value.length} rendered entries` },
		{
			label: 'Available aggregate space',
			value: `${(totalFreeSpace / 1024 / 1024 / 1024).toFixed(1)} GB`,
			hint: 'Chosen by max free-space allocator',
		},
		{
			label: 'Delta sync pulse',
			value: health.value?.sync?.lastRunAt ? 'Synced' : 'Pending',
			hint: health.value?.sync?.lastRunAt || 'Waiting for next cron interval',
		},
	];
});

async function refreshDashboard() {
	await Promise.all([fileTreeStore.loadFiles('/'), accountStore.loadAccounts()]);
	health.value = await api.getHealth();
}

function consumeGoogleCallbackState() {
	const url = new URL(window.location.href);
	const status = url.searchParams.get('google');
	const message = url.searchParams.get('message');

	if (!status) return;

	if (status === 'connected') {
		refreshDashboard();
	}

	if (status === 'error' && message) {
		fileTreeStore.error = `Google Drive: ${message}`;
	}

	url.searchParams.delete('google');
	url.searchParams.delete('message');
	window.history.replaceState({}, '', url);
}

function handleFilesSelected(files) {
	uploadQueueStore.uploadFiles(files, currentPath.value, async () => {
		await fileTreeStore.loadFiles(currentPath.value);
	});
}

onMounted(() => {
	refreshDashboard();
	consumeGoogleCallbackState();
});
</script>

<template>
	<main class="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
		<section class="rounded-[32px] bg-gradient-to-br from-[#e8f0fe] via-[#f5f9ff] to-white p-6 shadow-sm sm:p-8">
			<div>
				<p class="text-xs font-semibold uppercase tracking-[0.14em] text-[#1a73e8]">OmniCloud</p>
				<h1 class="mt-3 max-w-4xl text-3xl font-bold tracking-tight text-[#202124] sm:text-4xl">
					Stateless multi-cloud workspace with a unified virtual namespace
				</h1>
				<p class="mt-4 max-w-3xl text-sm leading-7 text-[#5f6368] sm:text-base">
					Node.js proxies stream payloads straight to cloud targets, SQLite mirrors metadata,
					and Vue renders a pooled explorer with real-time upload telemetry.
				</p>
			</div>
			<div class="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
				<StatsCard v-for="stat in stats" :key="stat.label" :label="stat.label" :value="stat.value" :hint="stat.hint" />
			</div>
		</section>

		<section class="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_380px]">
			<div class="space-y-6">
				<UploadDropzone @files-selected="handleFilesSelected" />
				<FileExplorer :files="filteredFiles" :breadcrumbs="breadcrumbs" :current-path="currentPath" :search-term="searchTerm" :loading="isLoading" @navigate="fileTreeStore.navigate" @search="fileTreeStore.applySearch" />
				<p v-if="error" class="rounded-2xl bg-[#fce8e6] px-4 py-3 text-sm text-[#c5221f]">{{ error }}</p>
			</div>
			<div class="space-y-6">
				<StorageAccountsPanel :accounts="accounts" />
				<section class="rounded-[28px] border border-[#e6ebf2] bg-white p-6 shadow-sm">
					<p class="text-xs font-semibold uppercase tracking-[0.14em] text-[#1a73e8]">Background workers</p>
					<h2 class="mt-2 text-2xl font-semibold text-[#202124]">Polling engine status</h2>
					<p class="mt-4 text-sm leading-6 text-[#5f6368]">
						Last probe:
						<strong class="text-[#202124]">{{ health?.sync?.lastRunAt || 'not yet executed' }}</strong>
					</p>
					<div class="mt-4 grid gap-3 text-sm text-[#5f6368]">
						<div class="flex items-center justify-between rounded-2xl bg-[#f8fafd] px-4 py-3">
							<span>Scanned accounts</span>
							<strong class="text-[#202124]">{{ health?.sync?.scannedAccounts || 0 }}</strong>
						</div>
						<div class="flex items-center justify-between rounded-2xl bg-[#f8fafd] px-4 py-3">
							<span>Detected changes</span>
							<strong class="text-[#202124]">{{ health?.sync?.changesDetected || 0 }}</strong>
						</div>
					</div>
				</section>
			</div>
		</section>

		<FloatingProgressToast :uploads="uploads" :total-progress="totalProgress" @close="uploadQueueStore.clearOperations" @close-item="uploadQueueStore.closeOperation" />
	</main>
</template>
