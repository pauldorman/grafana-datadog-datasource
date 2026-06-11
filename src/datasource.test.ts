import { DataSourceInstanceSettings } from '@grafana/data';
import { DataSource } from './datasource';
import { MyDataSourceOptions, MyVariableQuery } from './types';

const mockPost = jest.fn().mockResolvedValue({ values: ['mocked-result'] });

// Mock the backend/runtime dependencies
jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({
    get: jest.fn(),
    post: mockPost,
  }),
  getTemplateSrv: () => ({
    replace: jest.fn((a) => a),
  }),
  DataSourceWithBackend: class MockDataSourceWithBackend {
    id: number;
    uid: string;
    name: string;
    constructor(instanceSettings: DataSourceInstanceSettings<MyDataSourceOptions>) {
      this.id = instanceSettings.id || 1;
      this.uid = instanceSettings.uid;
      this.name = instanceSettings.name;
    }
  },
}));

describe('DataSource variable query parser', () => {
  let datasource: DataSource;
  const uid = 'datadog-uid';

  beforeEach(() => {
    // Setup a basic mock instance settings
    const instanceSettings = {
      id: 1,
      uid,
      name: 'Datadog',
      type: 'datadog',
      jsonData: {},
    } as unknown as DataSourceInstanceSettings<MyDataSourceOptions>;

    datasource = new DataSource(instanceSettings);
    mockPost.mockClear();
  });

  describe('metricFindQuery string parsing', () => {
    it('should parse JSON query strings correctly', async () => {
      const jsonQuery = JSON.stringify({ queryType: 'metrics', metricName: 'system.cpu.user' });
      await datasource.metricFindQuery(jsonQuery);
      
      expect(mockPost).toHaveBeenCalledWith(`/api/datasources/uid/${uid}/resources/metrics`, {
        searchPattern: 'system.cpu.user'
      });
    });

    describe('Primary API Patterns', () => {
      it('should parse tag_values(metricName, tagKey)', async () => {
        await datasource.metricFindQuery('tag_values(datadog.cost.amortized, datadog_product)');
        
        expect(mockPost).toHaveBeenCalledWith(`/api/datasources/uid/${uid}/resources/tag-values`, {
          metricName: 'datadog.cost.amortized',
          tagKey: 'datadog_product'
        });
      });

      it('should parse tag_keys(metricName)', async () => {
        await datasource.metricFindQuery('tag_keys(system.cpu.user)');
        
        expect(mockPost).toHaveBeenCalledWith(`/api/datasources/uid/${uid}/resources/tag-keys`, {
          metricName: 'system.cpu.user'
        });
      });

      it('should parse tag_names(metricName) as tag_keys', async () => {
        await datasource.metricFindQuery('tag_names(system.cpu.user)');
        
        expect(mockPost).toHaveBeenCalledWith(`/api/datasources/uid/${uid}/resources/tag-keys`, {
          metricName: 'system.cpu.user'
        });
      });

      it('should parse metrics(pattern)', async () => {
        await datasource.metricFindQuery('metrics(system.*)');
        
        expect(mockPost).toHaveBeenCalledWith(`/api/datasources/uid/${uid}/resources/metrics`, {
          searchPattern: 'system.*'
        });
      });
    });

    describe('Datadog Proprietary Legacy Patterns', () => {
      it('should parse all-metrics', async () => {
        await datasource.metricFindQuery('all-metrics');
        
        expect(mockPost).toHaveBeenCalledWith(`/api/datasources/uid/${uid}/resources/metrics`, {
          searchPattern: '*'
        });
      });

      it('should parse all-tags', async () => {
        await datasource.metricFindQuery('all-tags');
        
        // When metricName is '*', it fetches all tags without filtering by metric
        expect(mockPost).toHaveBeenCalledWith(`/api/datasources/uid/${uid}/resources/tag-keys`, {
          metricName: '*'
        });
      });

      it('should parse [metric]:all-tags', async () => {
        await datasource.metricFindQuery('datadog.cost.amortized:all-tags');
        
        expect(mockPost).toHaveBeenCalledWith(`/api/datasources/uid/${uid}/resources/tag-keys`, {
          metricName: 'datadog.cost.amortized'
        });
      });

      it('should parse [metric]:[tag]', async () => {
        await datasource.metricFindQuery('datadog.cost.amortized:datadog_product');
        
        expect(mockPost).toHaveBeenCalledWith(`/api/datasources/uid/${uid}/resources/tag-values`, {
          metricName: 'datadog.cost.amortized',
          tagKey: 'datadog_product'
        });
      });

      it('should parse single [tag]', async () => {
        await datasource.metricFindQuery('datadog_product');
        
        expect(mockPost).toHaveBeenCalledWith(`/api/datasources/uid/${uid}/resources/tag-values`, {
          metricName: '*',
          tagKey: 'datadog_product'
        });
      });
    });
    
    it('should return empty array for unsupported strings', async () => {
      const results = await datasource.metricFindQuery('unsupported:string:format()');
      
      expect(results).toEqual([]);
      expect(mockPost).not.toHaveBeenCalled();
    });
  });
});
