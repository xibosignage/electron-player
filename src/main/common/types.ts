export type InputLayoutType = {
    layoutId: number;
    response: any;
    path?: string;
    shortPath?: string;
    scheduleId?: number;
};

export type MediaInventoryFileType = {
    id: number | string;
    type: string;
    fileType: string;
    size: number;
    md5: string;
    path: string;
    saveAs: string;
};

export interface LocalFile {
    id?: number;
    name: string;
    url: string;
    localPath: string;
    size: number;
    status: string;
    fileId: string;
    type: string;
    fileType: string;
    md5: string;
    lastDownloaded: string;
}

export interface RequiredFile {
    id: string;
    type: string;
    fileType?: string;
    saveAs?: string;
    path?: string;
    size?: number;
    md5?: string;
    download?: string;
    layoutId?: number;
    regionId?: number;
    mediaId?: number;
    updated?: string;
    code?: string;
    updateInterval?: number;
    width?: number;
    height?: number;
    shortPath?: string | URL;
}

export const LogsThreshold = 100;
