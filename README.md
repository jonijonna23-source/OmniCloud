# OmniCloud

OmniCloud is a cloud-drive aggregation app that provides a Google Drive-inspired interface on top of multiple storage providers. It supports real provider connections through a shared adapter architecture.

## Highlights

- Real cloud account connections via provider-specific authentication
- Encrypted local storage for provider tokens, sessions, and credentials
- Unified file browser with virtual paths
- Google Drive-like `Home` and `My Drive` experience
- Folder creation, rename, delete, file details, and download
- File upload with drag-and-drop, file upload, and folder upload
- Upload progress over WebSocket
- Local metadata mirror in SQLite
- Scheduled synchronization to keep mirrored data aligned with provider state
- Dark mode support
- Tailwind CSS v4 UI with `@tabler/icons-vue`

## Current provider status

| Provider | Status |
| --- | --- |
| Google Drive | Implemented and actively used |
| OneDrive | Implemented with Microsoft Graph |
| Dropbox | Implemented with OAuth and Dropbox file APIs |
| MEGA | Implemented with MEGA login and file APIs |
| S3-compatible | Basic adapter groundwork |

## Monorepo structure

```text
OmniCloud/
├─ apps/
│  └─ web/           # Vue 3 frontend
├─ services/
│  └─ api/           # Express API, sync, adapters, SQLite
├─ blueprint.md      # Original architecture blueprint
├─ package.json      # Root workspace scripts
└─ README.md
```

## Tech stack

### Frontend
- Vue 3
- Vite
- Pinia
- Vue Router
- Tailwind CSS v4
- `@tabler/icons-vue`

### Backend
- Node.js
- Express
- WebSocket (`ws`)
- SQLite via `better-sqlite3`
- Provider API integrations and SDKs
- `node-cron` for background sync

## How it works

OmniCloud uses a passthrough-style backend:

- the frontend requests file operations through the API,
- the backend talks to the cloud provider,
- file and folder metadata are mirrored into SQLite,
- uploads stream through the backend and report progress over WebSocket,
- sync jobs refresh the local mirror so the UI reflects the latest remote state.

The goal is to let users browse a unified virtual file tree while still working with real provider data.

## Features

### Account connection
- Connect real cloud provider accounts
- Persist linked cloud account metadata locally
- Track quota usage per account

### File management
- Browse files by virtual path
- Open `Home` and `My Drive` views
- Create folders
- Rename files and folders
- Delete files and folders
- View file details
- Download files from the provider

### Uploads
- Upload files from the browser
- Upload folders
- Drag and drop files or folders into `My Drive`
- Show live progress via WebSocket

### UI/UX
- Google Drive-inspired layout
- Light and dark theme
- Context menu actions in `My Drive`
- Plus Jakarta Sans typography

## Requirements

Before running the project, make sure you have:

- Node.js 20+ recommended
- npm
- Provider credentials or account access as needed

## Setup

### 1. Install dependencies

From the repository root:

- `npm install`

If dependencies are already installed, you can skip this step.

### 2. Configure the API environment

Copy:

- `services/api/.env.example` → `services/api/.env`

Example environment values:

```env
PORT=8787
CORS_ORIGIN=http://localhost:5173
SYNC_INTERVAL_MINUTES=5
OMNICLOUD_SECRET_HALF=replace-this-with-random-half-key
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:8787/api/accounts/google/callback
ONEDRIVE_CLIENT_ID=
ONEDRIVE_CLIENT_SECRET=
ONEDRIVE_TENANT_ID=common
ONEDRIVE_REDIRECT_URI=http://localhost:8787/api/accounts/onedrive/callback
DROPBOX_CLIENT_ID=
DROPBOX_CLIENT_SECRET=
DROPBOX_REDIRECT_URI=http://localhost:8787/api/accounts/dropbox/callback
```

### 3. Configure provider credentials

Follow the detailed provider guide:

- [`docs/provider-setup.md`](docs/provider-setup.md)

## Running the project

### Development

Run frontend and backend together from the root:

- `npm run dev`

Default local URLs:

- Frontend: `http://localhost:5173`
- API: `http://localhost:8787`

### Frontend only build

- `npm run build`

### Backend only

- `npm start`

## Root scripts

Available commands in the root `package.json`:

- `npm run dev` — run API and web app in parallel
- `npm run build` — build the frontend
- `npm run dev:web` — run only the Vue app
- `npm run dev:api` — run only the API server
- `npm start` — start the backend server

## Main API endpoints

### Health
- `GET /api/health`

### Accounts
- `GET /api/accounts`
- Provider connect/status routes are available under `/api/accounts/...`

### Files
- `GET /api/files?path=/`
- `GET /api/files/:id`
- `GET /api/files/:id/download`
- `PATCH /api/files/:id/rename`
- `DELETE /api/files/:id`
- `POST /api/files/folders`

### Uploads
- `POST /api/uploads/initiate`
- `POST /api/uploads/:uploadId/stream`
- `WS /ws/uploads?uploadId=...`

## Project notes

- The local database is stored in `services/api/omnicloud.db`.
- Cloud metadata is mirrored locally and refreshed after relevant operations.
- Multi-provider pooling is not fully completed yet.
- Move operations and broader provider expansion are still future work.

## Security notes

- Do not commit `.env` or local database files.
- OAuth credentials, refresh tokens, provider credentials, and local database files are sensitive.
- Review your provider app consent configuration before using this project with real accounts.

## Roadmap

- Improve unified storage pooling logic
- Add move operations across the virtual file tree
- Harden multi-account production readiness

## Related files

- `blueprint.md` — original architecture and system design
- `docs/provider-setup.md` — detailed credential setup for supported providers
- `apps/web/README.md` — frontend template/readme source
- `services/api/README.md` — backend-specific short readme

## License

No explicit license has been defined yet in this repository.
