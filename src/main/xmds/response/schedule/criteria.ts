export type CriteriaResponseType = {
    _: string;
    $: Exclude<CriteriaType, 'value'>;
}

export type CriteriaType = {
    metric: string;
    condition: string;
    type: string;
    value: string;
};

export function criteria(response: CriteriaResponseType): CriteriaType {
    if (!criteria) return <CriteriaType>{};

    return <CriteriaType>{
        condition: response.$.condition,
        metric: response.$.metric,
        type: response.$.type,
        value: response._,
    };
}
