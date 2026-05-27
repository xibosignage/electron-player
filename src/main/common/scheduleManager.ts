import { createNanoEvents, Emitter } from "nanoevents";
import Schedule from "../xmds/response/schedule/schedule";
import { Layout } from "../xmds/response/schedule/events/layout";
import { DefaultLayout } from "../xmds/response/schedule/events/defaultLayout";
import { Config } from "../config/config";
import { getLayoutIds } from "./parser";
import { InputLayoutType } from "./types";
import { getLayoutFile, isPurging } from "./fileManager";
import { OverlayLayout } from "../xmds/response/schedule/events/overlayLayout";
import SspLayout from "../xmds/response/schedule/events/sspLayout";
import { geoLocationManager } from "./geoLocationManager";
import { scheduleCriteriaManager } from "../../shared/scheduleCriteria/scheduleCriteriaManager";

export type ScheduleLayoutsType = Layout | DefaultLayout | SspLayout;

interface ScheduleEvents {
    layouts: (object: ScheduleLayoutsType[]) => void;
    overlays: (object: OverlayLayout[]) => void;
}

export default class ScheduleManager {
    emitter: Emitter<ScheduleEvents>;

    interval: number = -1;
    isAssessing: boolean = false;
    isAssessingLayouts: boolean = false;
    isAssessingOverlays: boolean = false;

    schedule: Schedule;

    sspShareOfVoice: number = 0;
    sspAverageDuration: number = 0;

    layouts: ScheduleLayoutsType[];
    overlays: OverlayLayout[];

    lastPlayedAt: Date | null = null;
    playStats: { [scheduleId: number]: number } = {};
    scheduleIdsThatHaveMaxPlays: number[] = [];

    config: Config;

    constructor(schedule: Schedule, config: Config) {
        this.emitter = createNanoEvents<ScheduleEvents>();
        this.schedule = schedule;
        this.layouts = [];
        this.overlays = [];
        this.layouts.push(this.getSplash());
        this.config = config;
    }

    on<E extends keyof ScheduleEvents>(event: E, callback: ScheduleEvents[E]) {
        return this.emitter.on(event, callback);
    }

    async start(interval: number) {
        if (this.interval > 0) {
            clearInterval(this.interval);
        }

        // checkRf/checkSchedule are the values we obtained the last time this ran.
        // @ts-ignore
        this.interval = setInterval(async () => {
            // Regular collection.
            await this.assessLayouts();
            await this.assessOverlays();
        }, interval * 1000);
        
        await this.assessLayouts();
        await this.assessOverlays();
    }

    async update(schedule: Schedule) {
        this.schedule = schedule;
    }

    async updateSspSov(shareOfVoice: number, averageDuration: number) {
        this.sspShareOfVoice = shareOfVoice;
        this.sspAverageDuration = averageDuration;

        console.info('SSP Share of Voice and Average Duration changed to '
            + this.sspShareOfVoice + ' / ' + this.sspAverageDuration, {
            method: 'Schedule: Manager: Assess'
        });
    }

    /**
     * Assess normal layouts from the current schedule
     */
    async assessLayouts() {
        if (this.isAssessingLayouts) {
            console.info('Still active, skipping.', {
                method: 'Schedule: Manager: Assess'
            });
            return;
        }

        if (isPurging) {
            console.debug('[ScheduleManager::assessLayouts] > Purge in progress, skipping assessment.', {
                method: 'Schedule: Manager: Assess'
            });
            return;
        }

        // if (!await this.isGlobalDependenciesValid()) {
        //     console.debug('Global dependencies not ready, skipping.', {
        //         method: 'Schedule: Manager: Assess'
        //     });
        //     return;
        // }

        this.isAssessingLayouts = true;

        // If we don't have anything to assess, drop out straight away.
        let hasChanged = false;
        if (!this.schedule || (this.schedule.countLayouts() <= 0 && !this.schedule.defaultLayout)) {
            // No layouts in the schedule
            console.info('No layouts in the schedule and no default, show splash screen', {
                method: 'Schedule: Manager: Assess',
            });
            this.config.state.scheduleLoop = 'Splash only';
            this.layouts = [this.getSplash()];
            this.emitter.emit('layouts', [this.getSplash()]);
            this.isAssessingLayouts = false;
            return;
        }

        // Run through the schedule and pull out the new layout loop.
        const now = new Date();
        let loop: ScheduleLayoutsType[] = [];
        let interruptLayouts: ScheduleLayoutsType[] = [];

        // Do we have SSP
        if (this.sspShareOfVoice > 0) {
            const sspLayout = new SspLayout();
            sspLayout.duration = this.sspAverageDuration;
            sspLayout.shareOfVoice = this.sspShareOfVoice;

            interruptLayouts.push(sspLayout);
        }

        // Reset playStats if the last recorded play time is from a different hour.
        // This ensures layouts with max play limits can start playing again after the reset.
        if (this.lastPlayedAt && this.lastPlayedAt.getHours() !== now.getHours()) {
            this.playStats = {};
        }

        // Start evaluating layouts
        const skippedLayoutIds: number[] = [];
        const validLayoutIds: number[] = [];
        const evaluatedLayouts  = (await Promise.all(
            this.schedule.layouts.map(layout => this.evaluateLayout(layout, now, skippedLayoutIds, validLayoutIds))
        )).filter(l => l !== null);

        // Find the highest priority
        const maxPriority = Math.max(...evaluatedLayouts.map(l => l?.priority ?? 0));

        // Keep only layouts with the highest priority
        // If all layouts share the same priority value, then they are all included
        const tempLayouts = evaluatedLayouts.filter(l => l?.priority === maxPriority);

        let [layouts, interrupts] = tempLayouts.reduce(
            ([normalLayouts, interrupts]: [ScheduleLayoutsType[], ScheduleLayoutsType[]], layout) => {
                if (layout === null) {
                    return [normalLayouts, interrupts];
                }

                if (layout.isInterrupt()) {
                    interrupts.push(layout as ScheduleLayoutsType);
                } else {
                    normalLayouts.push(layout as ScheduleLayoutsType);
                }

                return [normalLayouts, interrupts];
            },
            [[], []]
        );

        if (interrupts.length > 0) {
            interruptLayouts = [...interruptLayouts, ...interrupts];
        }

        // We must have at least 1 normal schedule before we assess interrupts.
        if (layouts.length <= 0 &&
          this.schedule &&
          this.schedule.defaultLayout && await this.schedule.defaultLayout.isValid()
        ) {
            console.debug('[ScheduleManager::assessLayouts] > No layouts, showing default layout.', {
                method: 'Schedule: Manager: Assess'
            });
            layouts.push(this.schedule.defaultLayout);
        }

        // Are there any interrupts?
        if (interruptLayouts.length > 0) {
            console.debug('Interrupt layouts in schedule, assessing the loop for share of voice', {
                method: 'Schedule: Manager: Assess'
            });

            let resolvedNormalLayouts: ScheduleLayoutsType[] = [];
            let resolvedInterruptLayouts: ScheduleLayoutsType[] = [];

            let index = 0;
            let interruptSecondsInHour = 0;
            let satisfied = false;

            while (!satisfied) {
                // Have we gone all the way around?
                if (index >= interruptLayouts.length) {
                    index = 0;

                    // Check if all of our interrupts are satisfied.
                    let allSatisfied = true;
                    interruptLayouts.forEach((el) => {
                        if (!el.isInterruptDurationSatisfied()) {
                            allSatisfied = false;
                        }
                    });

                    if (allSatisfied) {
                        satisfied = true;
                        continue;
                    }
                }

                // Get the layout at this index
                if (!interruptLayouts[index].isInterruptDurationSatisfied()) {
                    interruptLayouts[index].addCommittedInterruptDuration();
                    interruptSecondsInHour += interruptLayouts[index].duration;

                    // Add this again
                    resolvedInterruptLayouts.push(interruptLayouts[index]);
                }

                index++;
            }

            if (interruptSecondsInHour >= 3600) {
                loop = resolvedInterruptLayouts;
            } else {
                // We should fill up the remaining time with normal layouts
                let normalSecondsInHour = 3600 - interruptSecondsInHour;
                let index = 0;
                while (normalSecondsInHour > 0) {
                    if (index >= layouts.length) {
                        index = 0;
                    }

                    normalSecondsInHour -= layouts[index].duration;
                    resolvedNormalLayouts.push(layouts[index]);
                }

                // Now we combine them together.
                const pickCount = Math.max(resolvedInterruptLayouts.length, resolvedNormalLayouts.length);

                // Take the ceiling of normal and the floor of interrupt
                const normalPick = Math.ceil(1.0 * pickCount / resolvedNormalLayouts.length);
                const interruptPick = Math.floor(1.0 * pickCount / resolvedInterruptLayouts.length);

                let normalIndex = 0;
                let interruptIndex = 0;
                let totalSecondsAllocated = 0;
                let i = 0;

                while (i < pickCount) {
                    // Determine whether we should pick from normal and interrupt lists on this
                    // iteration.
                    // Normal first
                    if (i % normalPick == 0) {
                        // We allow over picking from the normal list
                        if (normalIndex >= resolvedNormalLayouts.length) {
                            normalIndex = 0;
                        }
                        loop.push(resolvedNormalLayouts[normalIndex]);
                        totalSecondsAllocated += resolvedNormalLayouts[normalIndex].duration;
                        normalIndex++;
                    }

                    // Interrupt second
                    // Only pick an interrupt if we are a pick turn, and if we haven't already picked
                    // them all.
                    if (i % interruptPick == 0 && interruptIndex < resolvedInterruptLayouts.length) {
                        loop.push(resolvedInterruptLayouts[interruptIndex]);
                        totalSecondsAllocated += resolvedInterruptLayouts[interruptIndex].duration;
                        interruptIndex++;
                    }

                    i++;
                }

                // It is possible to have some time left over at the end, as our pick indexes are ceiling and floor
                while (totalSecondsAllocated < 3600) {
                    // Fill up the remaining time with normal events.
                    // We allow over picking from the normal list
                    if (normalIndex >= resolvedNormalLayouts.length) {
                        normalIndex = 0;
                    }
                    loop.push(resolvedNormalLayouts[normalIndex]);
                    totalSecondsAllocated += resolvedNormalLayouts[normalIndex].duration;
                    normalIndex++;
                }
            }
        } else {
            // No interrupts, just take the entire normal schedule loop.
            loop = layouts;
        }

        // Ensure loop is never empty, fallback to default layout or splash screen
        if (loop.length === 0) {
            if (this.schedule?.defaultLayout && await this.schedule.defaultLayout.isValid()) {
                loop = [this.schedule.defaultLayout];
            } else {
                loop = [this.getSplash()];
            }
        }

        // Is this layout loop different to the current one?
        // can we store a count and hash or similar?
        // We don't have change if this.layouts has splash screen only
        const splashScreenOnly = this.layouts.length === 1 &&
            this.layouts[0].file === 0;

        if (loop.length > 0 && splashScreenOnly) {
            this.layouts = [];
            hasChanged = true;
        } else if (!splashScreenOnly && this.layouts.length !== loop.length) {
            hasChanged = true;
        } else if (!splashScreenOnly && this.layouts.length === loop.length) {
            const existingLayoutIds = getLayoutIds(this.layouts);
            const newLayoutIds = getLayoutIds(loop);
            hasChanged = existingLayoutIds.join(',') !== newLayoutIds.join(',');
        }

        if (hasChanged) {
            console.debug('[ScheduleManager::assessLayouts] > Assessment finished, schedule loop changed', {
                loop,
                method: 'Schedule: Manager: Assess'
            });

            this.layouts = loop;

            // Add index to each layout
            this.layouts = this.layouts.map((
                layout: ScheduleLayoutsType,
                layoutIndex
            ) => {
                let _layout = layout;

                _layout = _layout.clone();

                _layout.index = layoutIndex;

                return _layout;
            });

            this.emitter.emit('layouts', this.layouts);
        } else {
            console.debug('[ScheduleManager::assessLayouts] > Assessment finished, no change', {
                method: 'Schedule: Manager: Assess'
            });
        }

        // Status window state updates
        if (this.layouts.length > 0) {
            this.config.state.scheduleLoop = this.layouts.map((el) => {
                return el.hash();
            }).join(', ');
        }

        console.debug('[ScheduleManager::assessLayouts] > Assessment of layouts finished', {
            method: 'Schedule: Manager: Assess Layouts',
            scheduleLoop: this.config.state.scheduleLoop,
        });
        this.config.state.invalidLayoutIds = skippedLayoutIds;
        this.config.state.validLayoutIds = validLayoutIds;

        // Build the full layout list for display, marking unscheduled ones with * and the default with (D)
        const loopIds = new Set(loop.map(l => l.file));
        const allLayouts = this.schedule.layouts.map(l =>
            l.file + (loopIds.has(l.file) ? '' : '*')
        );
        if (this.schedule.defaultLayout) {
            const defaultId = this.schedule.defaultLayout.file;
            allLayouts.push(defaultId + ' (D)' + (loopIds.has(defaultId) ? '' : '*'));
        }
        this.config.state.allLayoutIds = allLayouts.join(', ');

        this.isAssessingLayouts = false;
    }

    /**
     * Assess overlay layouts from the current schedule
     */
    async assessOverlays() {
        if (this.isAssessingOverlays) {
            console.debug('[ScheduleManager::assessOverlays] > Still assessing overlays, skipping', {
                method: 'Schedule: Manager: Assess Overlays',
            });

            return;
        }

        if (isPurging) {
            console.debug('[ScheduleManager::assessOverlays] > Purge in progress, skipping assessment.', {
                method: 'Schedule: Manager: Assess Overlays'
            });
            return;
        }
        this.isAssessingOverlays = true;

        // If we don't have anything to assess, drop out straight away.
        let hasChanged = false;
        if (!this.schedule || (this.schedule && this.schedule.overlays.length === 0)) {
            this.overlays = [];
            this.isAssessingOverlays = false;
            this.emitter.emit('overlays', this.overlays);
            return;
        }

        // Run through the schedule and pull out the new overlay layout loop.
        const now = new Date();
        let loop: OverlayLayout[] = [];

        // Reset playStats if the last recorded play time is from a different hour.
        // This ensures layouts with max play limits can start playing again after the reset.
        if (this.lastPlayedAt && this.lastPlayedAt.getHours() !== now.getHours()) {
            this.playStats = {};
        }

        // Update overlays to be played in the player
        const evaluatedOverlays = (await Promise.all(
            this.schedule.overlays.map(overlay => this.evaluateLayout(overlay, now))
        )).filter((o): o is OverlayLayout => o !== null);

        // Find the highest priority
        const maxPriority = Math.max(...evaluatedOverlays.map(l => l.priority));

        // Keep only overlays with the highest priority
        // If all overlays share the same priority value, then they are all included
        loop = evaluatedOverlays.filter(l => l.priority === maxPriority);

        if (loop.length === 0) {
            console.debug('[ScheduleManager::assessOverlays] > No overlays', {
                method: 'Schedule: Manager: Assess Overlays',
            });
            this.overlays = [];
            this.isAssessingOverlays = false;
            this.emitter.emit('overlays', this.overlays);
            return;
        } else {
            if (this.overlays.length !== loop.length) {
                hasChanged = true;
            } else if (this.overlays.length === loop.length) {
                const existingOverlays = getLayoutIds(this.overlays);
                const newOverlays = getLayoutIds(loop);
                hasChanged = existingOverlays.join(',') !== newOverlays.join(',');
            }
        }

        if (hasChanged) {
            console.debug('[ScheduleManager::assessOverlays] > Assessment finished, overlays loop changed', {
                loop,
                method: 'Schedule: Manager: Assess',
                shouldParse: false,
            });
            this.overlays = loop;
            this.emitter.emit('overlays', this.overlays);
        }

        console.debug('[ScheduleManager::assessOverlays] > Assessment of overlays finished', {
            method: 'Schedule: Manager: Assess Overlays',
        });

        this.isAssessingOverlays = false;
    }

    /**
     * Assess commands from the current schedule
     * 
     * @returns An array of eligible commands that can be scheduled for execution
     */
    async assessCommands() {
        if (!this.schedule || !Array.isArray(this.schedule.commands)) {
            return [];
        }

        const now = new Date();

        const evaluatedCommands =  this.schedule.commands.filter(command => {
            const executeAt = new Date(command.date).getTime();

            // Skip commands that are already in the past
            if (executeAt < now.getTime()) {
                return false;
            }

            // If there is criteria, then evaluate all criteria attached to the command
            if (command.hasCriteria()) {
                for (const {metric, condition, value} of command.criteria ?? []) {
                    const matched = scheduleCriteriaManager.evaluateCriteria(
                        metric,
                        condition,
                        value
                    );

                    if (!matched) {
                        return false;
                    }
                }
            }

            // Handle geofence logic if applicable
            if (command.isGeoAware) {
                // Extract the polygon from the command's geoLocation
                const geo = JSON.parse(command.geoLocation);
                const polygon = geo.geometry.coordinates[0];

                // Check if the device's current location falls inside the polygon
                const insidePolygon = geoLocationManager.isCurrentLocationInsidePolygon(polygon);

                // If the device is outside the polygon, skip this command
                if (!insidePolygon) {
                    return false;
                }
            }

            return true;
        });

        if (evaluatedCommands.length === 0) {
            return [];
        }

        // Find the highest priority
        const maxPriority = Math.max(...evaluatedCommands.map(c => c.priority));

        // Keep only command/s with the highest priority
        // If all commands share the same priority value, then they are all included
        return evaluatedCommands.filter(c => c.priority === maxPriority);
    }

    /**
     * Evaluates whether a layout is eligible for playback at the given time.
     * Resets interrupt tracking and checks date range, file availability, and
     * schedule criteria before allowing it into the playback loop.
     *
     * @param layout - The layout instance to evaluate.
     * @param now - The current timestamp used for validation.
     * @private
     */
    private async evaluateLayout<T extends (Layout | OverlayLayout)>(layout: T, now: Date, skipped?: number[], valid?: number[]) {
        // Reset interrupt tracking
        layout.interruptCommittedDuration = 0;

        // Check if it's within the active date range
        if (!(now > layout.getFromDt() && now < layout.getToDt())) {
            return null;
        }

        // Validate file existence
        const isLayoutValid = await layout.isValid();
        if (!isLayoutValid) {
            console.debug('[ScheduleManager::evaluateLayout] > Layout invalid, skipping.', {
                layoutId: layout.file,
                method: 'Schedule: Manager: Assess'
            });
            skipped?.push(layout.file);
            return null;
        }

        valid?.push(layout.file);

        // Evaluate criteria (if any)
        if (layout.hasCriteria()) {
            for (const { metric, condition, value } of layout.criteria ?? []) {
                const matched = scheduleCriteriaManager.evaluateCriteria(metric, condition, value);
                if (!matched) {
                    return null;
                }
            }
        }

        // Handle geofence logic if applicable
        if (layout.isGeoAware) {
            // Extract the polygon from the layout's geoLocation
            const geo = JSON.parse(layout.geoLocation);
            const polygon = geo.geometry.coordinates[0];

            // Check if the device's current location falls inside thsse polygon
            const insidePolygon = geoLocationManager.isCurrentLocationInsidePolygon(polygon);

            // If the device is outside the polygon, skip this layout
            if (!insidePolygon) {
                console.debug('[ScheduleManager::evaluateLayout] > Layout outside geofence, skipping.', {
                    layoutId: layout.file,
                    method: 'Schedule: Manager: Assess'
                });
                return null;
            }
        }

        // Keep track of layouts that might be affected by play counts
        if (layout.maxPlaysPerHour > 0 && layout.scheduleId != null) {
            if (!this.scheduleIdsThatHaveMaxPlays.includes(layout.scheduleId)) {
                this.scheduleIdsThatHaveMaxPlays.push(layout.scheduleId);
            }
        }

        // Skip layouts that already reached the max plays per hour limit
        if (
            layout.maxPlaysPerHour > 0 &&
            layout.scheduleId !== null &&
            this.playStats[layout.scheduleId] &&
            this.playStats[layout.scheduleId] >= layout.maxPlaysPerHour
        ) {
            return null;
        }

        return layout;
    }

    /**
     * Get the current layout loop.
     */
    getLayoutLoop(): InputLayoutType[] {
        return this.layouts.reduce((arr: InputLayoutType[], item) => {
            const layoutFile = getLayoutFile(item.file);

            return [
                ...arr,
                {
                    layoutId: item.file,
                    path: layoutFile && layoutFile !== null ? layoutFile.name : '',
                    shortPath: layoutFile && layoutFile !== null ? layoutFile.name : '',
                    response: item.response,
                }
            ];
        }, []);
    }

    /**
     * Get overlays
     */
    getOverlays() {
        return this.overlays;
    }

    getSplash() {
        const splash = new DefaultLayout();
        splash.path = '0.xlf';
        return splash;
    }

    hasSplashScreen(layouts: ScheduleLayoutsType[]) {
        for (const layout of layouts) {
            if (layout.file === 0) return true;
        }

        return false;
    }

    /**
     * Increment play count for a schedule.
     * Resets counts on hour change and triggers assessLayouts() if the schedule has a max plays per hour limit.
     *
     * @param scheduleId
     */
    async incrementPlayCount(scheduleId: number | undefined) {
        if (scheduleId == null) {
            return;
        }

        // Record the last play date
        this.lastPlayedAt = new Date();

        // Increment the play count for this scheduleId
        if (!this.playStats[scheduleId]) {
            this.playStats[scheduleId] = 0;
        }
        this.playStats[scheduleId]++;

        // Do we need to assess immediately?
        // if scheduleIdsThatHaveMaxPlays has this scheduleId inside it, make an assessment immediately
        if (this.scheduleIdsThatHaveMaxPlays.includes(<number>scheduleId)) {
            await this.assessLayouts();
        }
    }

    getPlayStats(scheduleId?: number) {
        if (scheduleId && Boolean(this.playStats[scheduleId])) {
            return this.playStats[scheduleId];
        }

        return this.playStats;
    }
}