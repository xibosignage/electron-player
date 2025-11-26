import { createNanoEvents, Emitter } from "nanoevents";
import Schedule from "../xmds/response/schedule/schedule";
import { Layout } from "../xmds/response/schedule/events/layout";
import { DefaultLayout } from "../xmds/response/schedule/events/defaultLayout";
import { State } from "./state";
import { Config } from "../config/config";
import { app } from "electron";
import { getLayoutIds } from "./parser";
import { InputLayoutType } from "./types";
import { getLayoutFile } from "./fileManager";

export type ScheduleLayoutsType = Layout | DefaultLayout; // Add SspLayout

interface ScheduleEvents {
    layouts: (object: ScheduleLayoutsType[]) => void;
}

const state = new State();
const config = new Config(app, process.platform, state);

export default class ScheduleManager {
    emitter: Emitter<ScheduleEvents>;

    interval: number = -1;
    isAssessing: boolean = false;

    schedule: Schedule;

    sspShareOfVoice: number = 0;
    sspAverageDuration: number = 0;

    layouts: ScheduleLayoutsType[];

    lastPlayedAt: Date | null = null;
    playStats: { [scheduleId: number]: number } = {};
    scheduleIdsThatHaveMaxPlays: number[] = [];

    constructor(schedule: Schedule) {
        this.emitter = createNanoEvents<ScheduleEvents>();
        this.schedule = schedule;
        this.layouts = [];
        this.layouts.push(this.getSplash());
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
            await this.assess();
        }, interval * 1000);

        await this.assess();
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
     * Assess the current schedule
     */
    async assess() {
        if (this.isAssessing) {
            console.info('Still active, skipping.', {
                method: 'Schedule: Manager: Assess'
            });
            return;
        }
        this.isAssessing = true;

        // If we don't have anything to assess, drop out straight away.
        let hasChanged = false;
        if (!this.schedule || (this.schedule.countLayouts() <= 0 && !this.schedule.defaultLayout)) {
            // No layouts in the schedule
            console.info('No layouts in the schedule and no default, show splash screen', {
                method: 'Schedule: Manager: Assess',
            });
            config.state.scheduleLoop = 'Splash only';
            this.layouts = [this.getSplash()];
            this.emitter.emit('layouts', [this.getSplash()]);
            this.isAssessing = false;
            return;
        }

        // Run through the schedule and pull out the new layout loop.
        const now = new Date();
        let loop: ScheduleLayoutsType[] = [];
        let interruptLayouts: ScheduleLayoutsType[] = [];
        let maxPriority = 0;

        // Do we have SSP
        // if (this.sspShareOfVoice > 0) {
        //     const sspLayout = new SspLayout();
        //     sspLayout.duration = this.sspAverageDuration;
        //     sspLayout.shareOfVoice = this.sspShareOfVoice;

        //     interruptLayouts.push(sspLayout);
        // }

        const tempLayouts = (await Promise.all(
            this.schedule.layouts.map(async (layout) => {
                // Reset any state tracking for this assessment.
                layout.interruptCommittedDuration = 0;

                // Is this schedule in date.
                if (!(now > layout.getFromDt() && now < layout.getToDt())) {
                    // Outside schedule window.
                    return null;
                }

                // Is it valid?
                const isLayoutValid = await layout.isValid();
                if (!isLayoutValid) {
                    return null;
                }

                // Is any schedule criteria active?
                if (layout.hasCriteria()) {
                    // If we don't match, return.
                    // TODO: matching criteria
                    return null;
                }

                // Is it inside the geofence (if applicable)
                if (layout.isGeoAware) {
                    // If we don't have a valid location, return
                    // TODO: Load the GeoJSON
                    //  If we aren't inside the location, return
                    return null;
                }

                // Keep track of the layouts that might be affected by play counts
                if (layout.maxPlaysPerHour > 0 && layout.scheduleId != null) {
                    if (!this.scheduleIdsThatHaveMaxPlays.includes(layout.scheduleId)) {
                        this.scheduleIdsThatHaveMaxPlays.push(layout.scheduleId);
                    }
                }

                // Does it have a max plays per hour and have it reached?
                if (layout.maxPlaysPerHour > 0 &&
                    layout.scheduleId !== null &&
                    this.playStats[layout.scheduleId] &&
                    this.playStats[layout.scheduleId] >= layout.maxPlaysPerHour
                ) {
                    // We already hit the max plays in the current hour, so do not include
                    return null;
                }

                // By this point we know we can include it, but is it superseded by layouts with higher priority?
                // Is the priority a new highest priority?
                if (layout.priority > maxPriority) {
                    // This is a layout with a higher priority
                    layouts = [];
                    maxPriority = layout.priority;
                } else if (layout.priority < maxPriority) {
                    // Lower priority than the max, so do not include
                    return null;
                }

                return layout;
            })
        )).filter(l => l !== null);

        let [layouts, interrupts] = tempLayouts.reduce(
            ([normalLayouts, interrupts]: [ScheduleLayoutsType[], ScheduleLayoutsType[]], layout) => {
                if (layout.isInterrupt()) {
                    interrupts.push(layout);
                } else {
                    normalLayouts.push(layout);
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
            console.debug('>>>> XLR.debug No layouts, showing default layout.', {
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

        console.debug('>>>>> XLR.debug Assess complete, hasChanged = ' + hasChanged, {
            loop: { length: loop.length, ids: getLayoutIds(loop), },
            layouts: { length: layouts.length, ids: getLayoutIds(layouts), },
            thisLayouts: { length: this.layouts.length, ids: getLayoutIds(this.layouts), },
            method: 'Schedule: Manager: Assess'
        });

        if (hasChanged) {
            console.debug('>>>> XLR.debug Assessment finished, schedule loop changed', {
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
            console.debug('>>>> XLR.debug Assessment finished, no change', {
                method: 'Schedule: Manager: Assess'
            });
        }

        // Update the status window with the new layout loop.
        if (this.layouts.length > 0) {
            config.state.scheduleLoop = this.layouts.map((el) => {
                return el.hash();
            }).join(', ');
        }

        this.isAssessing = false;
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
     * Resets counts on hour change and triggers assess() if the schedule has a max plays per hour limit.
     *
     * @param scheduleId
     */
    async incrementPlayCount(scheduleId: number | undefined) {
        if (scheduleId == null) {
            return;
        }

        // If the last play date is old, reset everything
        const now = new Date();
        if (this.lastPlayedAt && this.lastPlayedAt.getHours() !== now.getHours()) {
            this.playStats = {};
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
            await this.assess();
        }
    }

    getPlayStats(scheduleId?: number) {
        if (scheduleId && Boolean(this.playStats[scheduleId])) {
            return this.playStats[scheduleId];
        }

        return this.playStats;
    }
}