import { Entity } from "dexie";

import PlayerDB from "./db";
import { LogAlertEventType, LogAlertType, LogCategoryType } from "../loggerLib";

export default class LogsDB extends Entity<PlayerDB> {
    uid!: string;
    date!: string;
    message!: string;
    category!: LogCategoryType;
    method?: string;
    scheduleId?: string;
    layoutId?: string;
    mediaId?: string;
    eventType?: LogAlertEventType;
    alertType?: LogAlertType;
    refId?: string;
    timestamp!: number;
}
