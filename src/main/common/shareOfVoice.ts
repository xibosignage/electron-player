/*
 * Copyright (c) 2026 Xibo Signage Ltd
 *
 * Xibo - Digital Signage - https://xibosignage.com
 *
 * This file is part of Xibo.
 *
 * Xibo is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * any later version.
 *
 * Xibo is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Xibo.  If not, see <http://www.gnu.org/licenses/>.
 */

// Seconds a layout counts for when its duration is missing, zero or not a number.
export const DEFAULT_LOOP_DURATION = 60;

/**
 * The duration a layout counts for when the schedule loop is built.
 *
 * The share of voice loops keep adding layouts until the hour is filled, so a
 * duration of 0 or NaN would keep them running forever. Such a layout counts
 * for DEFAULT_LOOP_DURATION instead. This only affects how the hour is divided;
 * the layout still plays for its own length.
 *
 * @param duration The duration from the schedule, in seconds.
 * @return {number} A positive number of seconds.
 */
export function loopDuration(duration: number): number {
  return Number.isFinite(duration) && duration > 0 ? duration : DEFAULT_LOOP_DURATION;
}
