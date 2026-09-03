// pbjs JSON descriptor for the three OTLP/HTTP export request types.
//
// Generated from open-telemetry/opentelemetry-proto @ dfd0b0e by:
//   npx tsx scripts/regenerate-otlp-descriptor.ts dfd0b0e
// which fetches that commit's proto tree, runs `pbjs -t json` over the three
// OTLP/HTTP service protos, and deletes the resulting *Service entries: they
// are gRPC service stubs this HTTP transcoder never uses, and their method
// descriptors do not type-check against protobufjs's INamespace (IMethod
// declares `comment` as required, but pbjs never emits one).
//
// To pick up a newer OTLP schema, re-run that command with a newer commit SHA
// from open-telemetry/opentelemetry-proto and replace the object below.
// Vendored as a .ts module (not .json) so the compiled dist ships it without
// resolveJsonModule or copy steps.
export const OTLP_DESCRIPTOR = {
  nested: {
    opentelemetry: {
      nested: {
        proto: {
          nested: {
            collector: {
              nested: {
                logs: {
                  nested: {
                    v1: {
                      options: {
                        csharp_namespace: 'OpenTelemetry.Proto.Collector.Logs.V1',
                        java_multiple_files: true,
                        java_package: 'io.opentelemetry.proto.collector.logs.v1',
                        java_outer_classname: 'LogsServiceProto',
                        go_package: 'go.opentelemetry.io/proto/otlp/collector/logs/v1',
                      },
                      nested: {
                        ExportLogsServiceRequest: {
                          fields: {
                            resourceLogs: {
                              rule: 'repeated',
                              type: 'opentelemetry.proto.logs.v1.ResourceLogs',
                              id: 1,
                              protoName: 'resource_logs',
                            },
                          },
                        },
                        ExportLogsServiceResponse: {
                          fields: {
                            partialSuccess: {
                              type: 'ExportLogsPartialSuccess',
                              id: 1,
                              protoName: 'partial_success',
                            },
                          },
                        },
                        ExportLogsPartialSuccess: {
                          fields: {
                            rejectedLogRecords: {
                              type: 'int64',
                              id: 1,
                              protoName: 'rejected_log_records',
                            },
                            errorMessage: {
                              type: 'string',
                              id: 2,
                              protoName: 'error_message',
                            },
                          },
                        },
                      },
                    },
                  },
                },
                metrics: {
                  nested: {
                    v1: {
                      options: {
                        csharp_namespace: 'OpenTelemetry.Proto.Collector.Metrics.V1',
                        java_multiple_files: true,
                        java_package: 'io.opentelemetry.proto.collector.metrics.v1',
                        java_outer_classname: 'MetricsServiceProto',
                        go_package: 'go.opentelemetry.io/proto/otlp/collector/metrics/v1',
                      },
                      nested: {
                        ExportMetricsServiceRequest: {
                          fields: {
                            resourceMetrics: {
                              rule: 'repeated',
                              type: 'opentelemetry.proto.metrics.v1.ResourceMetrics',
                              id: 1,
                              protoName: 'resource_metrics',
                            },
                          },
                        },
                        ExportMetricsServiceResponse: {
                          fields: {
                            partialSuccess: {
                              type: 'ExportMetricsPartialSuccess',
                              id: 1,
                              protoName: 'partial_success',
                            },
                          },
                        },
                        ExportMetricsPartialSuccess: {
                          fields: {
                            rejectedDataPoints: {
                              type: 'int64',
                              id: 1,
                              protoName: 'rejected_data_points',
                            },
                            errorMessage: {
                              type: 'string',
                              id: 2,
                              protoName: 'error_message',
                            },
                          },
                        },
                      },
                    },
                  },
                },
                trace: {
                  nested: {
                    v1: {
                      options: {
                        csharp_namespace: 'OpenTelemetry.Proto.Collector.Trace.V1',
                        java_multiple_files: true,
                        java_package: 'io.opentelemetry.proto.collector.trace.v1',
                        java_outer_classname: 'TraceServiceProto',
                        go_package: 'go.opentelemetry.io/proto/otlp/collector/trace/v1',
                      },
                      nested: {
                        ExportTraceServiceRequest: {
                          fields: {
                            resourceSpans: {
                              rule: 'repeated',
                              type: 'opentelemetry.proto.trace.v1.ResourceSpans',
                              id: 1,
                              protoName: 'resource_spans',
                            },
                          },
                        },
                        ExportTraceServiceResponse: {
                          fields: {
                            partialSuccess: {
                              type: 'ExportTracePartialSuccess',
                              id: 1,
                              protoName: 'partial_success',
                            },
                          },
                        },
                        ExportTracePartialSuccess: {
                          fields: {
                            rejectedSpans: {
                              type: 'int64',
                              id: 1,
                              protoName: 'rejected_spans',
                            },
                            errorMessage: {
                              type: 'string',
                              id: 2,
                              protoName: 'error_message',
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            logs: {
              nested: {
                v1: {
                  options: {
                    csharp_namespace: 'OpenTelemetry.Proto.Logs.V1',
                    java_multiple_files: true,
                    java_package: 'io.opentelemetry.proto.logs.v1',
                    java_outer_classname: 'LogsProto',
                    go_package: 'go.opentelemetry.io/proto/otlp/logs/v1',
                  },
                  nested: {
                    LogsData: {
                      fields: {
                        resourceLogs: {
                          rule: 'repeated',
                          type: 'ResourceLogs',
                          id: 1,
                          protoName: 'resource_logs',
                        },
                      },
                    },
                    ResourceLogs: {
                      fields: {
                        resource: {
                          type: 'opentelemetry.proto.resource.v1.Resource',
                          id: 1,
                        },
                        scopeLogs: {
                          rule: 'repeated',
                          type: 'ScopeLogs',
                          id: 2,
                          protoName: 'scope_logs',
                        },
                        schemaUrl: {
                          type: 'string',
                          id: 3,
                          protoName: 'schema_url',
                        },
                      },
                      reserved: [[1000, 1000]],
                    },
                    ScopeLogs: {
                      fields: {
                        scope: {
                          type: 'opentelemetry.proto.common.v1.InstrumentationScope',
                          id: 1,
                        },
                        logRecords: {
                          rule: 'repeated',
                          type: 'LogRecord',
                          id: 2,
                          protoName: 'log_records',
                        },
                        schemaUrl: {
                          type: 'string',
                          id: 3,
                          protoName: 'schema_url',
                        },
                      },
                    },
                    SeverityNumber: {
                      values: {
                        SEVERITY_NUMBER_UNSPECIFIED: 0,
                        SEVERITY_NUMBER_TRACE: 1,
                        SEVERITY_NUMBER_TRACE2: 2,
                        SEVERITY_NUMBER_TRACE3: 3,
                        SEVERITY_NUMBER_TRACE4: 4,
                        SEVERITY_NUMBER_DEBUG: 5,
                        SEVERITY_NUMBER_DEBUG2: 6,
                        SEVERITY_NUMBER_DEBUG3: 7,
                        SEVERITY_NUMBER_DEBUG4: 8,
                        SEVERITY_NUMBER_INFO: 9,
                        SEVERITY_NUMBER_INFO2: 10,
                        SEVERITY_NUMBER_INFO3: 11,
                        SEVERITY_NUMBER_INFO4: 12,
                        SEVERITY_NUMBER_WARN: 13,
                        SEVERITY_NUMBER_WARN2: 14,
                        SEVERITY_NUMBER_WARN3: 15,
                        SEVERITY_NUMBER_WARN4: 16,
                        SEVERITY_NUMBER_ERROR: 17,
                        SEVERITY_NUMBER_ERROR2: 18,
                        SEVERITY_NUMBER_ERROR3: 19,
                        SEVERITY_NUMBER_ERROR4: 20,
                        SEVERITY_NUMBER_FATAL: 21,
                        SEVERITY_NUMBER_FATAL2: 22,
                        SEVERITY_NUMBER_FATAL3: 23,
                        SEVERITY_NUMBER_FATAL4: 24,
                      },
                    },
                    LogRecordFlags: {
                      values: {
                        LOG_RECORD_FLAGS_DO_NOT_USE: 0,
                        LOG_RECORD_FLAGS_TRACE_FLAGS_MASK: 255,
                      },
                    },
                    LogRecord: {
                      fields: {
                        timeUnixNano: {
                          type: 'fixed64',
                          id: 1,
                          protoName: 'time_unix_nano',
                        },
                        observedTimeUnixNano: {
                          type: 'fixed64',
                          id: 11,
                          protoName: 'observed_time_unix_nano',
                        },
                        severityNumber: {
                          type: 'SeverityNumber',
                          id: 2,
                          protoName: 'severity_number',
                        },
                        severityText: {
                          type: 'string',
                          id: 3,
                          protoName: 'severity_text',
                        },
                        body: {
                          type: 'opentelemetry.proto.common.v1.AnyValue',
                          id: 5,
                        },
                        attributes: {
                          rule: 'repeated',
                          type: 'opentelemetry.proto.common.v1.KeyValue',
                          id: 6,
                        },
                        droppedAttributesCount: {
                          type: 'uint32',
                          id: 7,
                          protoName: 'dropped_attributes_count',
                        },
                        flags: {
                          type: 'fixed32',
                          id: 8,
                        },
                        traceId: {
                          type: 'bytes',
                          id: 9,
                          protoName: 'trace_id',
                        },
                        spanId: {
                          type: 'bytes',
                          id: 10,
                          protoName: 'span_id',
                        },
                        eventName: {
                          type: 'string',
                          id: 12,
                          protoName: 'event_name',
                        },
                      },
                      reserved: [[4, 4]],
                    },
                  },
                },
              },
            },
            common: {
              nested: {
                v1: {
                  options: {
                    csharp_namespace: 'OpenTelemetry.Proto.Common.V1',
                    java_multiple_files: true,
                    java_package: 'io.opentelemetry.proto.common.v1',
                    java_outer_classname: 'CommonProto',
                    go_package: 'go.opentelemetry.io/proto/otlp/common/v1',
                  },
                  nested: {
                    AnyValue: {
                      oneofs: {
                        value: {
                          oneof: [
                            'stringValue',
                            'boolValue',
                            'intValue',
                            'doubleValue',
                            'arrayValue',
                            'kvlistValue',
                            'bytesValue',
                            'stringValueStrindex',
                          ],
                        },
                      },
                      fields: {
                        stringValue: {
                          type: 'string',
                          id: 1,
                          protoName: 'string_value',
                        },
                        boolValue: {
                          type: 'bool',
                          id: 2,
                          protoName: 'bool_value',
                        },
                        intValue: {
                          type: 'int64',
                          id: 3,
                          protoName: 'int_value',
                        },
                        doubleValue: {
                          type: 'double',
                          id: 4,
                          protoName: 'double_value',
                        },
                        arrayValue: {
                          type: 'ArrayValue',
                          id: 5,
                          protoName: 'array_value',
                        },
                        kvlistValue: {
                          type: 'KeyValueList',
                          id: 6,
                          protoName: 'kvlist_value',
                        },
                        bytesValue: {
                          type: 'bytes',
                          id: 7,
                          protoName: 'bytes_value',
                        },
                        stringValueStrindex: {
                          type: 'int32',
                          id: 8,
                          protoName: 'string_value_strindex',
                        },
                      },
                    },
                    ArrayValue: {
                      fields: {
                        values: {
                          rule: 'repeated',
                          type: 'AnyValue',
                          id: 1,
                        },
                      },
                    },
                    KeyValueList: {
                      fields: {
                        values: {
                          rule: 'repeated',
                          type: 'KeyValue',
                          id: 1,
                        },
                      },
                    },
                    KeyValue: {
                      fields: {
                        key: {
                          type: 'string',
                          id: 1,
                        },
                        value: {
                          type: 'AnyValue',
                          id: 2,
                        },
                        keyStrindex: {
                          type: 'int32',
                          id: 3,
                          protoName: 'key_strindex',
                        },
                      },
                    },
                    InstrumentationScope: {
                      fields: {
                        name: {
                          type: 'string',
                          id: 1,
                        },
                        version: {
                          type: 'string',
                          id: 2,
                        },
                        attributes: {
                          rule: 'repeated',
                          type: 'KeyValue',
                          id: 3,
                        },
                        droppedAttributesCount: {
                          type: 'uint32',
                          id: 4,
                          protoName: 'dropped_attributes_count',
                        },
                      },
                    },
                    EntityRef: {
                      fields: {
                        schemaUrl: {
                          type: 'string',
                          id: 1,
                          protoName: 'schema_url',
                        },
                        type: {
                          type: 'string',
                          id: 2,
                        },
                        idKeys: {
                          rule: 'repeated',
                          type: 'string',
                          id: 3,
                          protoName: 'id_keys',
                        },
                        descriptionKeys: {
                          rule: 'repeated',
                          type: 'string',
                          id: 4,
                          protoName: 'description_keys',
                        },
                      },
                    },
                  },
                },
              },
            },
            resource: {
              nested: {
                v1: {
                  options: {
                    csharp_namespace: 'OpenTelemetry.Proto.Resource.V1',
                    java_multiple_files: true,
                    java_package: 'io.opentelemetry.proto.resource.v1',
                    java_outer_classname: 'ResourceProto',
                    go_package: 'go.opentelemetry.io/proto/otlp/resource/v1',
                  },
                  nested: {
                    Resource: {
                      fields: {
                        attributes: {
                          rule: 'repeated',
                          type: 'opentelemetry.proto.common.v1.KeyValue',
                          id: 1,
                        },
                        droppedAttributesCount: {
                          type: 'uint32',
                          id: 2,
                          protoName: 'dropped_attributes_count',
                        },
                        entityRefs: {
                          rule: 'repeated',
                          type: 'opentelemetry.proto.common.v1.EntityRef',
                          id: 3,
                          protoName: 'entity_refs',
                        },
                      },
                    },
                  },
                },
              },
            },
            metrics: {
              nested: {
                v1: {
                  options: {
                    csharp_namespace: 'OpenTelemetry.Proto.Metrics.V1',
                    java_multiple_files: true,
                    java_package: 'io.opentelemetry.proto.metrics.v1',
                    java_outer_classname: 'MetricsProto',
                    go_package: 'go.opentelemetry.io/proto/otlp/metrics/v1',
                  },
                  nested: {
                    MetricsData: {
                      fields: {
                        resourceMetrics: {
                          rule: 'repeated',
                          type: 'ResourceMetrics',
                          id: 1,
                          protoName: 'resource_metrics',
                        },
                      },
                    },
                    ResourceMetrics: {
                      fields: {
                        resource: {
                          type: 'opentelemetry.proto.resource.v1.Resource',
                          id: 1,
                        },
                        scopeMetrics: {
                          rule: 'repeated',
                          type: 'ScopeMetrics',
                          id: 2,
                          protoName: 'scope_metrics',
                        },
                        schemaUrl: {
                          type: 'string',
                          id: 3,
                          protoName: 'schema_url',
                        },
                      },
                      reserved: [[1000, 1000]],
                    },
                    ScopeMetrics: {
                      fields: {
                        scope: {
                          type: 'opentelemetry.proto.common.v1.InstrumentationScope',
                          id: 1,
                        },
                        metrics: {
                          rule: 'repeated',
                          type: 'Metric',
                          id: 2,
                        },
                        schemaUrl: {
                          type: 'string',
                          id: 3,
                          protoName: 'schema_url',
                        },
                      },
                    },
                    Metric: {
                      oneofs: {
                        data: {
                          oneof: ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary'],
                        },
                      },
                      fields: {
                        name: {
                          type: 'string',
                          id: 1,
                        },
                        description: {
                          type: 'string',
                          id: 2,
                        },
                        unit: {
                          type: 'string',
                          id: 3,
                        },
                        gauge: {
                          type: 'Gauge',
                          id: 5,
                        },
                        sum: {
                          type: 'Sum',
                          id: 7,
                        },
                        histogram: {
                          type: 'Histogram',
                          id: 9,
                        },
                        exponentialHistogram: {
                          type: 'ExponentialHistogram',
                          id: 10,
                          protoName: 'exponential_histogram',
                        },
                        summary: {
                          type: 'Summary',
                          id: 11,
                        },
                        metadata: {
                          rule: 'repeated',
                          type: 'opentelemetry.proto.common.v1.KeyValue',
                          id: 12,
                        },
                      },
                      reserved: [
                        [4, 4],
                        [6, 6],
                        [8, 8],
                      ],
                    },
                    Gauge: {
                      fields: {
                        dataPoints: {
                          rule: 'repeated',
                          type: 'NumberDataPoint',
                          id: 1,
                          protoName: 'data_points',
                        },
                      },
                    },
                    Sum: {
                      fields: {
                        dataPoints: {
                          rule: 'repeated',
                          type: 'NumberDataPoint',
                          id: 1,
                          protoName: 'data_points',
                        },
                        aggregationTemporality: {
                          type: 'AggregationTemporality',
                          id: 2,
                          protoName: 'aggregation_temporality',
                        },
                        isMonotonic: {
                          type: 'bool',
                          id: 3,
                          protoName: 'is_monotonic',
                        },
                      },
                    },
                    Histogram: {
                      fields: {
                        dataPoints: {
                          rule: 'repeated',
                          type: 'HistogramDataPoint',
                          id: 1,
                          protoName: 'data_points',
                        },
                        aggregationTemporality: {
                          type: 'AggregationTemporality',
                          id: 2,
                          protoName: 'aggregation_temporality',
                        },
                      },
                    },
                    ExponentialHistogram: {
                      fields: {
                        dataPoints: {
                          rule: 'repeated',
                          type: 'ExponentialHistogramDataPoint',
                          id: 1,
                          protoName: 'data_points',
                        },
                        aggregationTemporality: {
                          type: 'AggregationTemporality',
                          id: 2,
                          protoName: 'aggregation_temporality',
                        },
                      },
                    },
                    Summary: {
                      fields: {
                        dataPoints: {
                          rule: 'repeated',
                          type: 'SummaryDataPoint',
                          id: 1,
                          protoName: 'data_points',
                        },
                      },
                    },
                    AggregationTemporality: {
                      values: {
                        AGGREGATION_TEMPORALITY_UNSPECIFIED: 0,
                        AGGREGATION_TEMPORALITY_DELTA: 1,
                        AGGREGATION_TEMPORALITY_CUMULATIVE: 2,
                      },
                    },
                    DataPointFlags: {
                      values: {
                        DATA_POINT_FLAGS_DO_NOT_USE: 0,
                        DATA_POINT_FLAGS_NO_RECORDED_VALUE_MASK: 1,
                      },
                    },
                    NumberDataPoint: {
                      oneofs: {
                        value: {
                          oneof: ['asDouble', 'asInt'],
                        },
                      },
                      fields: {
                        attributes: {
                          rule: 'repeated',
                          type: 'opentelemetry.proto.common.v1.KeyValue',
                          id: 7,
                        },
                        startTimeUnixNano: {
                          type: 'fixed64',
                          id: 2,
                          protoName: 'start_time_unix_nano',
                        },
                        timeUnixNano: {
                          type: 'fixed64',
                          id: 3,
                          protoName: 'time_unix_nano',
                        },
                        asDouble: {
                          type: 'double',
                          id: 4,
                          protoName: 'as_double',
                        },
                        asInt: {
                          type: 'sfixed64',
                          id: 6,
                          protoName: 'as_int',
                        },
                        exemplars: {
                          rule: 'repeated',
                          type: 'Exemplar',
                          id: 5,
                        },
                        flags: {
                          type: 'uint32',
                          id: 8,
                        },
                      },
                      reserved: [[1, 1]],
                    },
                    HistogramDataPoint: {
                      oneofs: {
                        _sum: {
                          oneof: ['sum'],
                        },
                        _min: {
                          oneof: ['min'],
                        },
                        _max: {
                          oneof: ['max'],
                        },
                      },
                      fields: {
                        attributes: {
                          rule: 'repeated',
                          type: 'opentelemetry.proto.common.v1.KeyValue',
                          id: 9,
                        },
                        startTimeUnixNano: {
                          type: 'fixed64',
                          id: 2,
                          protoName: 'start_time_unix_nano',
                        },
                        timeUnixNano: {
                          type: 'fixed64',
                          id: 3,
                          protoName: 'time_unix_nano',
                        },
                        count: {
                          type: 'fixed64',
                          id: 4,
                        },
                        sum: {
                          type: 'double',
                          id: 5,
                          options: {
                            proto3_optional: true,
                          },
                        },
                        bucketCounts: {
                          rule: 'repeated',
                          type: 'fixed64',
                          id: 6,
                          protoName: 'bucket_counts',
                        },
                        explicitBounds: {
                          rule: 'repeated',
                          type: 'double',
                          id: 7,
                          protoName: 'explicit_bounds',
                        },
                        exemplars: {
                          rule: 'repeated',
                          type: 'Exemplar',
                          id: 8,
                        },
                        flags: {
                          type: 'uint32',
                          id: 10,
                        },
                        min: {
                          type: 'double',
                          id: 11,
                          options: {
                            proto3_optional: true,
                          },
                        },
                        max: {
                          type: 'double',
                          id: 12,
                          options: {
                            proto3_optional: true,
                          },
                        },
                      },
                      reserved: [[1, 1]],
                    },
                    ExponentialHistogramDataPoint: {
                      oneofs: {
                        _sum: {
                          oneof: ['sum'],
                        },
                        _min: {
                          oneof: ['min'],
                        },
                        _max: {
                          oneof: ['max'],
                        },
                      },
                      fields: {
                        attributes: {
                          rule: 'repeated',
                          type: 'opentelemetry.proto.common.v1.KeyValue',
                          id: 1,
                        },
                        startTimeUnixNano: {
                          type: 'fixed64',
                          id: 2,
                          protoName: 'start_time_unix_nano',
                        },
                        timeUnixNano: {
                          type: 'fixed64',
                          id: 3,
                          protoName: 'time_unix_nano',
                        },
                        count: {
                          type: 'fixed64',
                          id: 4,
                        },
                        sum: {
                          type: 'double',
                          id: 5,
                          options: {
                            proto3_optional: true,
                          },
                        },
                        scale: {
                          type: 'sint32',
                          id: 6,
                        },
                        zeroCount: {
                          type: 'fixed64',
                          id: 7,
                          protoName: 'zero_count',
                        },
                        positive: {
                          type: 'Buckets',
                          id: 8,
                        },
                        negative: {
                          type: 'Buckets',
                          id: 9,
                        },
                        flags: {
                          type: 'uint32',
                          id: 10,
                        },
                        exemplars: {
                          rule: 'repeated',
                          type: 'Exemplar',
                          id: 11,
                        },
                        min: {
                          type: 'double',
                          id: 12,
                          options: {
                            proto3_optional: true,
                          },
                        },
                        max: {
                          type: 'double',
                          id: 13,
                          options: {
                            proto3_optional: true,
                          },
                        },
                        zeroThreshold: {
                          type: 'double',
                          id: 14,
                          protoName: 'zero_threshold',
                        },
                      },
                      nested: {
                        Buckets: {
                          fields: {
                            offset: {
                              type: 'sint32',
                              id: 1,
                            },
                            bucketCounts: {
                              rule: 'repeated',
                              type: 'uint64',
                              id: 2,
                              protoName: 'bucket_counts',
                            },
                          },
                        },
                      },
                    },
                    SummaryDataPoint: {
                      fields: {
                        attributes: {
                          rule: 'repeated',
                          type: 'opentelemetry.proto.common.v1.KeyValue',
                          id: 7,
                        },
                        startTimeUnixNano: {
                          type: 'fixed64',
                          id: 2,
                          protoName: 'start_time_unix_nano',
                        },
                        timeUnixNano: {
                          type: 'fixed64',
                          id: 3,
                          protoName: 'time_unix_nano',
                        },
                        count: {
                          type: 'fixed64',
                          id: 4,
                        },
                        sum: {
                          type: 'double',
                          id: 5,
                        },
                        quantileValues: {
                          rule: 'repeated',
                          type: 'ValueAtQuantile',
                          id: 6,
                          protoName: 'quantile_values',
                        },
                        flags: {
                          type: 'uint32',
                          id: 8,
                        },
                      },
                      reserved: [[1, 1]],
                      nested: {
                        ValueAtQuantile: {
                          fields: {
                            quantile: {
                              type: 'double',
                              id: 1,
                            },
                            value: {
                              type: 'double',
                              id: 2,
                            },
                          },
                        },
                      },
                    },
                    Exemplar: {
                      oneofs: {
                        value: {
                          oneof: ['asDouble', 'asInt'],
                        },
                      },
                      fields: {
                        filteredAttributes: {
                          rule: 'repeated',
                          type: 'opentelemetry.proto.common.v1.KeyValue',
                          id: 7,
                          protoName: 'filtered_attributes',
                        },
                        timeUnixNano: {
                          type: 'fixed64',
                          id: 2,
                          protoName: 'time_unix_nano',
                        },
                        asDouble: {
                          type: 'double',
                          id: 3,
                          protoName: 'as_double',
                        },
                        asInt: {
                          type: 'sfixed64',
                          id: 6,
                          protoName: 'as_int',
                        },
                        spanId: {
                          type: 'bytes',
                          id: 4,
                          protoName: 'span_id',
                        },
                        traceId: {
                          type: 'bytes',
                          id: 5,
                          protoName: 'trace_id',
                        },
                      },
                      reserved: [[1, 1]],
                    },
                  },
                },
              },
            },
            trace: {
              nested: {
                v1: {
                  options: {
                    csharp_namespace: 'OpenTelemetry.Proto.Trace.V1',
                    java_multiple_files: true,
                    java_package: 'io.opentelemetry.proto.trace.v1',
                    java_outer_classname: 'TraceProto',
                    go_package: 'go.opentelemetry.io/proto/otlp/trace/v1',
                  },
                  nested: {
                    TracesData: {
                      fields: {
                        resourceSpans: {
                          rule: 'repeated',
                          type: 'ResourceSpans',
                          id: 1,
                          protoName: 'resource_spans',
                        },
                      },
                    },
                    ResourceSpans: {
                      fields: {
                        resource: {
                          type: 'opentelemetry.proto.resource.v1.Resource',
                          id: 1,
                        },
                        scopeSpans: {
                          rule: 'repeated',
                          type: 'ScopeSpans',
                          id: 2,
                          protoName: 'scope_spans',
                        },
                        schemaUrl: {
                          type: 'string',
                          id: 3,
                          protoName: 'schema_url',
                        },
                      },
                      reserved: [[1000, 1000]],
                    },
                    ScopeSpans: {
                      fields: {
                        scope: {
                          type: 'opentelemetry.proto.common.v1.InstrumentationScope',
                          id: 1,
                        },
                        spans: {
                          rule: 'repeated',
                          type: 'Span',
                          id: 2,
                        },
                        schemaUrl: {
                          type: 'string',
                          id: 3,
                          protoName: 'schema_url',
                        },
                      },
                    },
                    Span: {
                      fields: {
                        traceId: {
                          type: 'bytes',
                          id: 1,
                          protoName: 'trace_id',
                        },
                        spanId: {
                          type: 'bytes',
                          id: 2,
                          protoName: 'span_id',
                        },
                        traceState: {
                          type: 'string',
                          id: 3,
                          protoName: 'trace_state',
                        },
                        parentSpanId: {
                          type: 'bytes',
                          id: 4,
                          protoName: 'parent_span_id',
                        },
                        flags: {
                          type: 'fixed32',
                          id: 16,
                        },
                        name: {
                          type: 'string',
                          id: 5,
                        },
                        kind: {
                          type: 'SpanKind',
                          id: 6,
                        },
                        startTimeUnixNano: {
                          type: 'fixed64',
                          id: 7,
                          protoName: 'start_time_unix_nano',
                        },
                        endTimeUnixNano: {
                          type: 'fixed64',
                          id: 8,
                          protoName: 'end_time_unix_nano',
                        },
                        attributes: {
                          rule: 'repeated',
                          type: 'opentelemetry.proto.common.v1.KeyValue',
                          id: 9,
                        },
                        droppedAttributesCount: {
                          type: 'uint32',
                          id: 10,
                          protoName: 'dropped_attributes_count',
                        },
                        events: {
                          rule: 'repeated',
                          type: 'Event',
                          id: 11,
                        },
                        droppedEventsCount: {
                          type: 'uint32',
                          id: 12,
                          protoName: 'dropped_events_count',
                        },
                        links: {
                          rule: 'repeated',
                          type: 'Link',
                          id: 13,
                        },
                        droppedLinksCount: {
                          type: 'uint32',
                          id: 14,
                          protoName: 'dropped_links_count',
                        },
                        status: {
                          type: 'Status',
                          id: 15,
                        },
                      },
                      nested: {
                        SpanKind: {
                          values: {
                            SPAN_KIND_UNSPECIFIED: 0,
                            SPAN_KIND_INTERNAL: 1,
                            SPAN_KIND_SERVER: 2,
                            SPAN_KIND_CLIENT: 3,
                            SPAN_KIND_PRODUCER: 4,
                            SPAN_KIND_CONSUMER: 5,
                          },
                        },
                        Event: {
                          fields: {
                            timeUnixNano: {
                              type: 'fixed64',
                              id: 1,
                              protoName: 'time_unix_nano',
                            },
                            name: {
                              type: 'string',
                              id: 2,
                            },
                            attributes: {
                              rule: 'repeated',
                              type: 'opentelemetry.proto.common.v1.KeyValue',
                              id: 3,
                            },
                            droppedAttributesCount: {
                              type: 'uint32',
                              id: 4,
                              protoName: 'dropped_attributes_count',
                            },
                          },
                        },
                        Link: {
                          fields: {
                            traceId: {
                              type: 'bytes',
                              id: 1,
                              protoName: 'trace_id',
                            },
                            spanId: {
                              type: 'bytes',
                              id: 2,
                              protoName: 'span_id',
                            },
                            traceState: {
                              type: 'string',
                              id: 3,
                              protoName: 'trace_state',
                            },
                            attributes: {
                              rule: 'repeated',
                              type: 'opentelemetry.proto.common.v1.KeyValue',
                              id: 4,
                            },
                            droppedAttributesCount: {
                              type: 'uint32',
                              id: 5,
                              protoName: 'dropped_attributes_count',
                            },
                            flags: {
                              type: 'fixed32',
                              id: 6,
                            },
                          },
                        },
                      },
                    },
                    Status: {
                      fields: {
                        message: {
                          type: 'string',
                          id: 2,
                        },
                        code: {
                          type: 'StatusCode',
                          id: 3,
                        },
                      },
                      reserved: [[1, 1]],
                      nested: {
                        StatusCode: {
                          values: {
                            STATUS_CODE_UNSET: 0,
                            STATUS_CODE_OK: 1,
                            STATUS_CODE_ERROR: 2,
                          },
                        },
                      },
                    },
                    SpanFlags: {
                      values: {
                        SPAN_FLAGS_DO_NOT_USE: 0,
                        SPAN_FLAGS_TRACE_FLAGS_MASK: 255,
                        SPAN_FLAGS_CONTEXT_HAS_IS_REMOTE_MASK: 256,
                        SPAN_FLAGS_CONTEXT_IS_REMOTE_MASK: 512,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
