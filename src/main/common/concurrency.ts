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

/**
 * Works through a list a few items at a time.
 *
 * `limit` of them start together, and each time one finishes the next one begins, so the
 * list is never busier than the limit allows. Results come back in list order.
 *
 * A limit below 1 is treated as 1, otherwise nothing would ever start.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);

  // No point starting more runners than there are items for them to take.
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));

  // The runners share this, so each one always picks up whatever is next in the list.
  let cursor = 0;

  await Promise.all(Array.from({ length: workers }, async () => {
    while (cursor < items.length) {
      const index = cursor++;

      // Held against its original position, so a slow item does not reorder the results.
      results[index] = await worker(items[index], index);
    }
  }));

  return results;
}
