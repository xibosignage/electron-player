export type InputLayoutType = {
    layoutId: number;
    response: any;
    path?: string;
    shortPath?: string;
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
