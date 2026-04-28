export interface AlertConditionDefinition {
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly nrqlQuery: string;
  readonly aggregationMethod: 'EVENT_FLOW' | 'EVENT_TIMER' | 'CADENCE';
  readonly aggregationWindow: number;
  readonly aggregationDelay?: number;
  readonly aggregationTimer?: number;
  readonly thresholdOperator: 'ABOVE' | 'ABOVE_OR_EQUALS' | 'BELOW' | 'BELOW_OR_EQUALS' | 'EQUALS' | 'NOT_EQUALS';
  readonly thresholdCritical: {
    readonly value: number;
    readonly duration: number;
    readonly occurrences: 'ALL' | 'AT_LEAST_ONCE';
  };
  readonly thresholdWarning?: {
    readonly value: number;
    readonly duration: number;
    readonly occurrences: 'ALL' | 'AT_LEAST_ONCE';
  };
  readonly violationTimeLimitSeconds: number;
}

export interface AlertPolicyDefinition {
  readonly name: string;
  readonly incidentPreference: 'PER_POLICY' | 'PER_CONDITION' | 'PER_CONDITION_AND_TARGET';
}
