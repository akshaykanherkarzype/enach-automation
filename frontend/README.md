# UPI Batch Frontend

React dashboard for UPI Invoice Generation and Invoice Charge batch operations.

## Stack

- React 19 + TypeScript + Vite 4 (pinned for GLIBC 2.31 hosts; bump to Vite 5/6 on newer OS)
- Material UI
- TanStack Query
- React Hook Form
- AG Grid
- Axios + React Router

## Quick start

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

App: [http://localhost:5173](http://localhost:5173)

Ensure the backend API is running on port 4000 (or update `VITE_API_BASE_URL`).

## Features

- Login with JWT (RBAC: View / Upload / Retry)
- Tabs: **Invoice Generation** | **Invoice Charge**
- Drag-and-drop CSV/XLSX upload + validation summary
- Batch history with live progress
- Batch details: ETA, records/min, workers, failed grid, logs
- Retry failed / Retry DLQ / Cancel / Download reports

## Dev login

- `admin@zype.local` / `password` (full access)
