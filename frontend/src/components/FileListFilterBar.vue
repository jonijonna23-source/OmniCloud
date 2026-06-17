<script setup>
import { computed } from 'vue';
import { IconChevronDown, IconCloud, IconCloudFilled, IconCheck, IconSearch, IconX, IconCloudUpload } from '@tabler/icons-vue';
import { useI18n } from 'vue-i18n';
import { getTypeFilterIcon } from '../composables/useFileType.js';
import { providerIcon, providerLabel } from '../composables/useFormatFile.js';

const { t } = useI18n();

const props = defineProps({
	typeOptions: { type: Array, required: true },
	ownerOptions: { type: Array, required: true },
	updatedOptions: { type: Array, required: true },
	selectedTypeFilter: { type: String, required: true },
	selectedOwnerFilter: { type: String, required: true },
	selectedUpdatedFilter: { type: String, required: true },
	activeFilterMenu: { type: [String, null], default: null },
	searchTerm: { type: String, default: '' },
	targetAccountOptions: { type: Array, default: () => [] },
	selectedTargetAccount: { type: String, default: 'auto' },
});

const emit = defineEmits([
	'toggle-filter-menu',
	'apply-filter',
	'clear-filter',
	'update:searchTerm',
	'update:selectedTargetAccount',
]);

function getFilterLabel(type, value) {
	if (type === 'type') return props.typeOptions.find((o) => o.value === value)?.label || t('filters.type');
	if (type === 'updated') return props.updatedOptions.find((o) => o.value === value)?.label || t('filters.modified');
	return value;
}

function renderOwnerLabel(value) {
	if (value === 'all') return t('filters.allOwners');
	const owner = props.ownerOptions.find((o) => o.key === value);
	if (!owner) return t('filters.allOwners');
	return `${owner.email} · ${providerLabel(owner.provider)}`;
}

function isFilterActive(type) {
	if (type === 'type') return props.selectedTypeFilter !== 'all';
	if (type === 'owner') return props.selectedOwnerFilter !== 'all';
	if (type === 'updated') return props.selectedUpdatedFilter !== 'all';
	return false;
}

const selectedAccountLabel = computed(() => {
	if (props.selectedTargetAccount === 'auto') return 'Auto (Sistem)';
	const account = props.targetAccountOptions.find((a) => a.id === props.selectedTargetAccount);
	return account ? account.email : 'Auto (Sistem)';
});

const selectedAccountProviderIcon = computed(() => {
	if (props.selectedTargetAccount === 'auto') return null;
	const account = props.targetAccountOptions.find((a) => a.id === props.selectedTargetAccount);
	return account ? providerIcon(account.provider) : null;
});
</script>

<template>
	<div class="flex w-full flex-col gap-3 sm:flex-row sm:items-center">
		<div class="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
			<div class="relative">
				<button type="button" class="inline-flex items-center gap-2 rounded-2xl border border-[#e0e3e7] bg-[#f8fafd] px-3.5 py-2.5 text-sm font-medium text-[#3c4043] transition hover:border-[#c7d2e0] hover:bg-white dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:bg-slate-800" @click.stop="emit('toggle-filter-menu', 'type')">
					<span>{{ getFilterLabel('type', selectedTypeFilter) }}</span>
					<IconX v-if="isFilterActive('type')" :size="16" :stroke="2" class="text-[#5f6368] transition hover:text-[#1a73e8] dark:text-slate-400 dark:hover:text-sky-300" @click.stop="emit('clear-filter', 'type')" />
					<IconChevronDown v-else :size="16" :stroke="2" class="text-[#5f6368] dark:text-slate-400" />
				</button>
				<div v-if="activeFilterMenu === 'type'" class="absolute right-0 top-full z-30 mt-2 min-w-[220px] overflow-hidden rounded-2xl border border-[#e0e3e7] bg-white p-2 shadow-[0_16px_40px_rgba(32,33,36,0.16)] dark:border-slate-700 dark:bg-slate-800">
					<button v-for="option in typeOptions" :key="option.value" type="button" class="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition text-[#202124] hover:bg-[#f8fafd] dark:text-slate-100 dark:hover:bg-slate-700/70" @click="emit('apply-filter', 'type', option.value)">
						<span class="flex items-center gap-2">
							<component :is="getTypeFilterIcon(option.value, selectedTypeFilter === option.value)" :size="16" :stroke="selectedTypeFilter === option.value ? 0 : 1.8" :class="selectedTypeFilter === option.value ? 'text-[#1a73e8] dark:text-sky-300' : 'text-[#5f6368] dark:text-slate-400'" />
							<span>{{ option.label }}</span>
						</span>
						<IconCheck v-if="selectedTypeFilter === option.value" :size="16" :stroke="2" class="text-[#1a73e8] dark:text-sky-300" />
					</button>
				</div>
			</div>

			<div class="relative">
				<button type="button" class="inline-flex items-center gap-2 rounded-2xl border border-[#e0e3e7] bg-[#f8fafd] px-3.5 py-2.5 text-sm font-medium text-[#3c4043] transition hover:border-[#c7d2e0] hover:bg-white dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:bg-slate-800" @click.stop="emit('toggle-filter-menu', 'owner')">
					<span>{{ renderOwnerLabel(selectedOwnerFilter) }}</span>
					<IconX v-if="isFilterActive('owner')" :size="16" :stroke="2" class="text-[#5f6368] transition hover:text-[#1a73e8] dark:text-slate-400 dark:hover:text-sky-300" @click.stop="emit('clear-filter', 'owner')" />
					<IconChevronDown v-else :size="16" :stroke="2" class="text-[#5f6368] dark:text-slate-400" />
				</button>
				<div v-if="activeFilterMenu === 'owner'" class="absolute right-0 top-full z-30 mt-2 min-w-[260px] overflow-hidden rounded-2xl border border-[#e0e3e7] bg-white p-2 shadow-[0_16px_40px_rgba(32,33,36,0.16)] dark:border-slate-700 dark:bg-slate-800">
					<button type="button" class="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm text-[#202124] hover:bg-[#f8fafd] dark:text-slate-100 dark:hover:bg-slate-700/70" @click="emit('apply-filter', 'owner', 'all')">
						<span class="flex min-w-0 items-center gap-2">
							<span class="flex size-5 shrink-0 items-center justify-center">
								<component :is="selectedOwnerFilter === 'all' ? IconCloudFilled : IconCloud" :size="16" :stroke="selectedOwnerFilter === 'all' ? 0 : 1.8" :class="selectedOwnerFilter === 'all' ? 'text-[#1a73e8] dark:text-sky-300' : 'text-[#5f6368] dark:text-slate-400'" />
							</span>
							<span>{{ t('filters.allOwners') }}</span>
						</span>
						<IconCheck v-if="selectedOwnerFilter === 'all'" :size="16" :stroke="2" class="text-[#1a73e8] dark:text-sky-300" />
					</button>
					<button v-for="owner in ownerOptions" :key="owner.key" type="button" class="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm text-[#202124] hover:bg-[#f8fafd] dark:text-slate-100 dark:hover:bg-slate-700/70" @click="emit('apply-filter', 'owner', owner.key)">
						<span class="flex min-w-0 items-center gap-2">
							<div v-if="providerIcon(owner.provider)" class="flex size-5 shrink-0 items-center justify-center rounded-full bg-white dark:bg-slate-900/70">
								<img :src="providerIcon(owner.provider)" :alt="providerLabel(owner.provider)" class="size-3.5 object-contain" />
							</div>
							<div v-else class="size-5 shrink-0"></div>
							<span class="flex min-w-0 flex-col">
								<span class="truncate">{{ owner.email }}</span>
							</span>
						</span>
						<IconCheck v-if="selectedOwnerFilter === owner.key" :size="16" :stroke="2" class="text-[#1a73e8] dark:text-sky-300" />
					</button>
				</div>
			</div>

			<div class="relative">
				<button type="button" class="inline-flex items-center gap-2 rounded-2xl border border-[#e0e3e7] bg-[#f8fafd] px-3.5 py-2.5 text-sm font-medium text-[#3c4043] transition hover:border-[#c7d2e0] hover:bg-white dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:bg-slate-800" @click.stop="emit('toggle-filter-menu', 'updated')">
					<span>{{ getFilterLabel('updated', selectedUpdatedFilter) }}</span>
					<IconX v-if="isFilterActive('updated')" :size="16" :stroke="2" class="text-[#5f6368] transition hover:text-[#1a73e8] dark:text-slate-400 dark:hover:text-sky-300" @click.stop="emit('clear-filter', 'updated')" />
					<IconChevronDown v-else :size="16" :stroke="2" class="text-[#5f6368] dark:text-slate-400" />
				</button>
				<div v-if="activeFilterMenu === 'updated'" class="absolute right-0 top-full z-30 mt-2 min-w-[240px] overflow-hidden rounded-2xl border border-[#e0e3e7] bg-white p-2 shadow-[0_16px_40px_rgba(32,33,36,0.16)] dark:border-slate-700 dark:bg-slate-800">
					<button v-for="option in updatedOptions" :key="option.value" type="button" class="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm text-[#202124] hover:bg-[#f8fafd] dark:text-slate-100 dark:hover:bg-slate-700/70" @click="emit('apply-filter', 'updated', option.value)">
						<span>{{ option.label }}</span>
						<IconCheck v-if="selectedUpdatedFilter === option.value" :size="16" :stroke="2" class="text-[#1a73e8] dark:text-sky-300" />
					</button>
				</div>
			</div>
		</div>

		<div class="flex ml-auto w-full min-w-0 shrink-0 flex-col gap-2.5 sm:ml-0 sm:w-auto sm:flex-row sm:items-center">
			<div class="relative">
				<button type="button" class="inline-flex h-11 items-center gap-2 rounded-full border border-[#e0e3e7] bg-[#f8fafd] px-4 text-sm font-medium text-[#3c4043] transition hover:border-[#c7d2e0] hover:bg-white dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:bg-slate-800" @click.stop="emit('toggle-filter-menu', 'target_account')">
					<span class="flex min-w-0 items-center gap-2">
						<IconCloudUpload v-if="selectedTargetAccount === 'auto'" :size="16" :stroke="1.8" class="text-[#5f6368] dark:text-slate-400" />
						<div v-else-if="selectedAccountProviderIcon" class="flex size-4 shrink-0 items-center justify-center rounded-full bg-white dark:bg-slate-900/70">
							<img :src="selectedAccountProviderIcon" alt="Provider" class="size-3 object-contain" />
						</div>
						<span class="truncate max-w-[120px]">{{ selectedAccountLabel }}</span>
					</span>
					<IconChevronDown :size="16" :stroke="2" class="text-[#5f6368] dark:text-slate-400" />
				</button>

				<div v-if="activeFilterMenu === 'target_account'" class="absolute right-0 top-full z-30 mt-2 min-w-[260px] overflow-hidden rounded-2xl border border-[#e0e3e7] bg-white p-2 shadow-[0_16px_40px_rgba(32,33,36,0.16)] dark:border-slate-700 dark:bg-slate-800">
					<div class="mb-2 px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-wider text-[#5f6368] dark:text-slate-400">Target Upload</div>
					<button type="button" class="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm text-[#202124] hover:bg-[#f8fafd] dark:text-slate-100 dark:hover:bg-slate-700/70" @click="emit('update:selectedTargetAccount', 'auto'); emit('toggle-filter-menu', null)">
						<span class="flex min-w-0 items-center gap-2">
							<span class="flex size-5 shrink-0 items-center justify-center">
								<IconCloudUpload :size="16" :stroke="selectedTargetAccount === 'auto' ? 2 : 1.8" :class="selectedTargetAccount === 'auto' ? 'text-[#1a73e8] dark:text-sky-300' : 'text-[#5f6368] dark:text-slate-400'" />
							</span>
							<span>Auto (Sistem)</span>
						</span>
						<IconCheck v-if="selectedTargetAccount === 'auto'" :size="16" :stroke="2" class="text-[#1a73e8] dark:text-sky-300" />
					</button>
					<button v-for="account in targetAccountOptions" :key="account.id" type="button" class="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm text-[#202124] hover:bg-[#f8fafd] dark:text-slate-100 dark:hover:bg-slate-700/70" @click="emit('update:selectedTargetAccount', account.id); emit('toggle-filter-menu', null)">
						<span class="flex min-w-0 items-center gap-2">
							<div v-if="providerIcon(account.provider)" class="flex size-5 shrink-0 items-center justify-center rounded-full bg-white dark:bg-slate-900/70">
								<img :src="providerIcon(account.provider)" :alt="providerLabel(account.provider)" class="size-3.5 object-contain" />
							</div>
							<div v-else class="size-5 shrink-0"></div>
							<span class="flex min-w-0 flex-col">
								<span class="truncate">{{ account.email }}</span>
							</span>
						</span>
						<IconCheck v-if="selectedTargetAccount === account.id" :size="16" :stroke="2" class="text-[#1a73e8] dark:text-sky-300" />
					</button>
				</div>
			</div>

			<div class="relative w-full min-w-0 sm:w-[280px]">
				<IconSearch :size="18" :stroke="2" class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#5f6368] dark:text-slate-400" />
				<input class="h-11 w-full rounded-full border border-[#dadce0] bg-white pl-11 pr-4 text-sm text-[#202124] outline-none transition focus:border-[#1a73e8] dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:focus:border-sky-400" type="search" :value="searchTerm" :placeholder="t('drive.searchInFolder')" @input="emit('update:searchTerm', $event.target.value)" />
			</div>
		</div>
	</div>
</template>
