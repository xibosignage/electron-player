
/**
 * Manages schedule criteria updates received from the CMS.
 * Use `addOrReplace()` to store or update criteria, which can later be
 * checked with `evaluateCriteria()` to determine if the stored criteria
 * meet specific conditions. Criteria are stored temporarily with a
 * time-to-live (TTL) value.
 *
 * Methods:
 * - `addOrReplace(metric, value, ttl)` - Adds or updates a metric in the active criteria list.
 * - `evaluateCriteria(metric, condition, value)` - Checks if a layout’s criteria match the current values.
 *  - `getActiveCriteria()` - Returns all currently active criteria.
 */
export class ScheduleCriteriaManager {
  private criteriaUpdates: {
    [metric: string]: {
      metric: string
      value: any
      ttl: number
      createdAt: number
    }
  } = {}

  /**
   * Add or replace a criteria update in the dictionary.
   * Each metric can only have one active value at a time.
   *
   * @param metric - The name of the metric (e.g. "temperature")
   * @param value - The value to store for the metric
   * @param ttl - Time-to-live in seconds (default: 60)
   */
  public addOrReplace(metric: string, value: any, ttl: number = 60) {
    if (!metric || value === undefined || value === null) {
      throw new Error("Both metric and value must be provided")
    }

    // Add new or replace existing entry for this metric
    this.criteriaUpdates[metric] = {
      metric,
      value,
      ttl,
      createdAt: Date.now()
    }
  }

  /**
   * Remove expired criteria from the dictionary.
   * If a metric is specified, only that metric is checked.
   * If no metric is given, all metrics are checked.
   *
   * @param metric
   * @private
   */
  private removeExpiredCriteria(metric?: string) {
    const currentTime = Date.now();

    if (metric) {
      // If metric is given, only check that one
      const criteria = this.criteriaUpdates[metric];
      if (criteria && criteria.createdAt + criteria.ttl * 1000 < currentTime) {
        // remove expired
        delete this.criteriaUpdates[metric];
      }
    } else {
      // No metric provided, loop through all metrics
      for (const key in this.criteriaUpdates) {
        const criteria = this.criteriaUpdates[key];
        if (criteria && criteria.createdAt + criteria.ttl * 1000 < currentTime) {
          // remove expired
          delete this.criteriaUpdates[key];
        }
      }
    }
  }

  /**
   * Evaluate a schedule's criteria against the current criteriaUpdate.
   *
   * @param metric - The metric to check (e.g. "temperature")
   * @param condition - The condition to evaluate ("eq", "lt", "gt", etc.)
   * @param value - The expected value from the schedule
   * @returns true if the criteria matches, false otherwise
   */
  public evaluateCriteria(metric: string, condition: string, value: any) {
    // Clear expired entries before evaluation
    this.removeExpiredCriteria(metric);

    const criteria = this.criteriaUpdates[metric];

    // If no criteria is found for the metric, fail
    if (!criteria) {
      return false;
    }

    // Apply condition logic based on the provided condition
    switch (condition) {
      case "eq":
        return criteria.value === value;
      case "neq":
        return criteria.value !== value;
      case "lt":
        return Number(criteria.value) < Number(value);
      case "lte":
        return Number(criteria.value) <= Number(value);
      case "gt":
        return Number(criteria.value) > Number(value);
      case "gte":
        return Number(criteria.value) >= Number(value);
      case "contains":
        return typeof criteria.value === "string" && criteria.value.includes(value);
      case "ncontains":
        return typeof criteria.value === "string" && !criteria.value.includes(value);
      case "set":
        return criteria.value !== undefined && criteria.value !== null;
      default:
        return false;
    }
  }

  /**
   * Get all currently active criteria.
   */
  public getActiveCriteria() {
    // Clear any expired criteria before returning
    this.removeExpiredCriteria();

    return this.criteriaUpdates
  }
}

export const scheduleCriteriaManager = new ScheduleCriteriaManager();
