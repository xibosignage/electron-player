/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LOCAL_SERVER_URL: string
  readonly VITE_LOCAL_SERVER_PORT: string
  readonly VITE_APP_VERSION: string
  readonly VITE_APP_VERSION_CODE: number
  // more env variables...
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}