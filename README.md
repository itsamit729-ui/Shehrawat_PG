# Sehrawat PG

The new standalone React + TypeScript frontend lives in [`frontend/`](./frontend). The original root HTML files remain as the visual reference and existing GitHub Pages prototype.

## Deploy the new frontend on Render

Use [`render.yaml`](./render.yaml) as a Blueprint, or create a **Static Site** with root directory `frontend`, build command `npm ci && npm run build`, publish directory `dist`, and rewrite `/*` to `/index.html`.

The frontend and backend deploy separately. `VITE_DEMO_MODE=true` enables the clearly labelled frontend review mode. When the backend is ready, set it to `false`, configure `VITE_API_BASE_URL`, and rebuild. Never put secrets in frontend environment variables.

- [Frontend setup, screens and deployment](./frontend/README.md)
- [Backend API contract](./frontend/API_CONTRACT.md)
- [Automated frontend checks](./.github/workflows/frontend-ci.yml)

The frontend includes public property discovery and booking, owner/resident/corporate portals, billing views, support, WhatsApp inbox/campaign controls, signing UI and reports. Real authentication, locks, ledger postings, payments, messaging and signing are backend integrations; the browser preview does not perform them.
