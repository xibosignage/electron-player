import { InputLayoutType, MediaInventoryFileType } from "./types";

export function getLayoutIds(layouts: InputLayoutType[]): number[] {
    return layouts.reduce((a: number[], b) => {
        return [...a, b.layoutId];
    }, []);
}



export function mediaInventoryFileXmlString(fileObj: MediaInventoryFileType, isComplete = false) {
    let xmlString = '&lt;file ' +
        'type=&quot;' + fileObj.type + '&quot; ' +
        'id=&quot;' + fileObj.id + '&quot; ' +
        'size=&quot;' + fileObj.size + '&quot; ' +
        'md5=&quot;' + fileObj.md5 + '&quot; ' +
        'complete=&quot;' + Number(isComplete) + '&quot; ' +
        'lastChecked=&quot;' + Date.now() + '&quot;';

    // Add fileType when fileObj.type = dependency
    if (fileObj.type === 'dependency') {
        xmlString += ' fileType=&quot;' + fileObj.fileType + '&quot; ';
    }

    xmlString += '/&gt;';

    return xmlString;
}

