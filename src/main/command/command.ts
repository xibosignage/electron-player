import { criteria, CriteriaResponseType, CriteriaType } from "../xmds/response/schedule/criteria";

export type CommandResponseType = {
    $: {
        code: string;
        date: string;
        scheduleid: string;
        priority?: string;
        isGeoAware?: string;
        geoLocation?: string;
    };
    criteria?: CriteriaResponseType[];
};

export class Command {
  readonly code: string;
  readonly date: string;
  readonly scheduleId: number;
  readonly criteria?: CriteriaType[];
  readonly response: CommandResponseType;
  readonly priority: number;
  readonly isGeoAware: boolean;
  readonly geoLocation: string;

  constructor(response: CommandResponseType) {
    this.response = response;

    // Parse command attributes
    this.code = this.response.$?.code ?? '';
    this.date = this.response.$?.date ?? '';
    this.scheduleId = parseInt(this.response.$?.scheduleid ?? '0');
    this.priority = parseInt(this.response.$?.priority ?? '0');
    this.isGeoAware = Boolean(Number(this.response.$?.isGeoAware));
    this.geoLocation = this.response.$?.geoLocation ?? '';

    this.criteria = this.response.criteria?.reduce((acc: CriteriaType[], item) => {
        const parsedCriteria = criteria(item);
        if (parsedCriteria) {
            acc.push(parsedCriteria);
        }
        return acc;
    }, []);

    console.debug('Command', {
        response: this.response,
        criteria: this.criteria,
    })
  }

  /**
   * Check if this command has any criteria
   */
  hasCriteria() {
    return this.criteria && this.criteria.length > 0;
  }
}