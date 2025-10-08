import { Entity } from 'dexie';
import PlayerDB from './db';

export default class FaultsDB extends Entity<PlayerDB> {
    code!: number;
    readon!: string;
    date?: string;
    expires?: string;
    mediaId?: number | string | null;
    regionId?: number | string | null;
    widgetId?: number | string | null;
    layoutId?: number | string | null;
    scheduleId?: number | string | null;
}