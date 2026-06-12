package plugin

import (
	"context"
	"testing"

	"github.com/DataDog/datadog-api-client-go/v2/api/datadogV2"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/stretchr/testify/assert"
)

func TestMetricsHandler_ProcessQuery_NoGrouping(t *testing.T) {
	// Setup
	datasource := &Datasource{}
	reqQueries := []backend.DataQuery{
		{RefID: "A"},
	}
	ddCtx := context.Background()
	var metricsApi *datadogV2.MetricsApi

	handler := NewMetricsHandler(datasource, reqQueries, ddCtx, metricsApi)

	// Test case: Query without "by" clause should pass through unmodified
	qm := &QueryModel{
		QueryText: "sum:datadog.cost.amortized{*}",
		Type:      "metrics",
	}

	err := handler.processQuery(qm)
	assert.NoError(t, err)

	// Verify
	assert.Len(t, handler.metricsQueries, 1)
	assert.Equal(t, "sum:datadog.cost.amortized{*}", handler.metricsQueries[0].MetricsTimeseriesQuery.Query)
}
