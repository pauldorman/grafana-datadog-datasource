import { getTemplateSrv } from '@grafana/runtime';
import { ScopedVars } from '@grafana/data';
import { MyQuery, VariableFormat, VariableInterpolationContext } from '../types';

/**
 * Service for handling variable interpolation in queries and labels.
 * Supports single and multi-value variables with custom formatting options.
 */
export class VariableInterpolationService {
  private templateSrv = getTemplateSrv();

  /**
   * Interpolates variables in a query object.
   * @param query - The query object to interpolate
   * @param scopedVars - Scoped variables for interpolation
   * @returns The query with interpolated values
   */
  interpolateQuery(query: MyQuery, scopedVars: ScopedVars): MyQuery {
    try {
      // Determine the effective legend template based on mode
      const effectiveLegendTemplate = query.legendMode === 'custom' && query.legendTemplate
        ? query.legendTemplate
        : '';

      const result: MyQuery = {
        ...query,
        queryText: this.interpolateMetricsQuery(query.queryText || '', scopedVars),
        legendTemplate: query.legendMode === 'custom'
          ? this.interpolateString(query.legendTemplate || '', scopedVars)
          : '',
        interpolatedQueryText: this.interpolateMetricsQuery(query.queryText || '', scopedVars),
        interpolatedLabel: this.interpolateString(effectiveLegendTemplate, scopedVars),
      };

      // Handle logs query interpolation with safety measures
      if (query.logQuery) {
        result.logQuery = this.interpolateLogsQuery(query.logQuery, scopedVars);
      }

      return result;
    } catch (error) {
      // Return original query as fallback
      return {
        ...query,
        interpolatedQueryText: query.queryText,
        interpolatedLabel: query.legendMode === 'custom' && query.legendTemplate
          ? query.legendTemplate
          : '',
        // Preserve original logQuery on error to prevent injection
        logQuery: query.logQuery,
      };
    }
  }

  /**
   * Interpolates variables in logs queries with safety measures to prevent injection
   * Extends existing variable interpolation patterns for Datadog logs search syntax
   */
  private interpolateLogsQuery(logQuery: string, scopedVars: ScopedVars): string {
    if (!logQuery) {
      return '';
    }

    try {
      // Handle custom format specifiers like ${variable:format} with logs-specific formatting
      let interpolated = logQuery.replace(/\$\{([^}:]+):([^}]+)\}/g, (match, varName, format) => {
        const variable = scopedVars[varName] || this.templateSrv.getVariables().find(v => v.name === varName);

        if (!variable) {
          return match; // Return original if variable not found
        }

        const context = this.createInterpolationContext(variable, format as VariableFormat);

        // Use logs-specific formatting for multi-value variables
        return this.formatMultiValueForLogs(context.values, context.format || 'logs');
      });

      // Handle simple variables like $variable with logs-safe interpolation
      interpolated = interpolated.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, varName) => {
        const variable = scopedVars[varName] || this.templateSrv.getVariables().find(v => v.name === varName);

        if (!variable) {
          return match; // Return original if variable not found
        }

        // Get variable values and apply logs-safe formatting
        const context = this.createInterpolationContext(variable, 'csv');
        return this.formatMultiValueForLogs(context.values, 'logs');
      });

      return interpolated;
    } catch (error) {
      return logQuery; // Return original query on error to prevent injection
    }
  }

  /**
   * Formats multi-value variables for Datadog logs search syntax with safety measures
   * Extends existing formatMultiValue method with logs-specific patterns
   */
  private formatMultiValueForLogs(values: string[], format: VariableFormat | 'logs' = 'logs'): string {
    // Handle empty or undefined values
    if (!values || values.length === 0) {
      return '';
    }

    // Filter out null, undefined, and empty string values, and sanitize for logs
    const filteredValues = values
      .filter(value =>
        value !== null &&
        value !== undefined &&
        value !== ''
      )
      .map(value => this.sanitizeLogsValue(String(value)));

    if (filteredValues.length === 0) {
      return '';
    }

    switch (format) {
      case 'logs':
        // Default logs format: use OR syntax for multiple values
        if (filteredValues.length === 1) {
          return filteredValues[0];
        }
        return `(${filteredValues.join(' OR ')})`;

      case 'lucene':
        // Use existing Lucene formatting with proper escaping
        return `(${filteredValues.map(v => `"${this.escapeLuceneValue(v)}"`).join(' OR ')})`;

      case 'csv':
        return filteredValues.join(',');

      case 'pipe':
        return filteredValues.join('|');

      case 'json':
        return JSON.stringify(filteredValues);

      case 'raw':
        // Return the first value for raw format
        return filteredValues[0];

      default:
        // Default to logs format for unknown formats
        if (filteredValues.length === 1) {
          return filteredValues[0];
        }
        return `(${filteredValues.join(' OR ')})`;
    }
  }

  /**
   * Sanitizes values for use in Datadog logs queries to prevent injection
   * Applies safety measures specific to logs search syntax
   */
  private sanitizeLogsValue(value: string): string {
    // Remove or escape potentially dangerous characters for logs queries
    // Datadog logs search uses Lucene-like syntax, so we need to escape special characters

    // First, trim whitespace
    let sanitized = value.trim();

    // Prevent injection of boolean operators at the start/end
    sanitized = sanitized.replace(/^(AND|OR|NOT)\s+/i, '');
    sanitized = sanitized.replace(/\s+(AND|OR|NOT)$/i, '');

    // Escape special Datadog logs search characters, but be more selective
    // Only escape characters that are truly problematic in logs search context
    sanitized = sanitized.replace(/[+&|!(){}[\]^"~*?:\\]/g, '\\$&');

    // Handle quotes - if the value contains spaces, wrap in quotes
    if (sanitized.includes(' ') && !sanitized.startsWith('"') && !sanitized.endsWith('"')) {
      sanitized = `"${sanitized}"`;
    }

    return sanitized;
  }

  /**
   * Sanitizes values for use in Datadog metric queries to prevent injection
   * Applies safety measures specific to metric search syntax
   */
  private sanitizeMetricValue(value: string): string {
    // Only pass through values matching safe charset
    // If it contains unrepresentable chars, log a warning and return empty string to drop it
    if (!/^[a-zA-Z0-9_\-./:]+$/.test(value)) {
      console.warn(`Datadog Datasource: Dropping unrepresentable metric scope value: "${value}". Metric scopes only support alphanumeric characters, underscores, hyphens, periods, slashes, and colons.`);
      return '';
    }
    return value;
  }

  /**
   * Interpolates variables in a label string.
   * @param label - The label string to interpolate
   * @param scopedVars - Scoped variables for interpolation
   * @returns The interpolated label string
   */
  interpolateLabel(label: string, scopedVars: ScopedVars): string {
    try {
      return this.interpolateString(label, scopedVars);
    } catch (error) {
      return label; // Fallback to original label
    }
  }

  /**
   * Interpolates variables in a metrics or cloud cost query with safety measures.
   * Handles Datadog-native boolean forms for multi-select variables.
   */
  private interpolateMetricsQuery(queryText: string, scopedVars: ScopedVars): string {
    if (!queryText) {
      return '';
    }

    try {
      // Handle custom format specifiers like ${variable:format} manually for backward compatibility
      let preprocessedQueryText = queryText.replace(/\$\{([^}:]+):([^}]+)\}/g, (match, varName, format) => {
        const variable = scopedVars[varName] || this.templateSrv.getVariables().find(v => v.name === varName);
        if (!variable) {
          return match;
        }
        const context = this.createInterpolationContext(variable, format as VariableFormat);
        return this.formatMultiValue(context.values, context.format || 'csv');
      });

      // Use Grafana's built-in replace with a custom format function
      // This correctly handles $__all (by resolving it to allValue before format runs), repeat panels, and scopedVars natively.
      const datadogFormat = (value: string | string[], variable: any) => {
        // Handle empty selections gracefully
        if (!value || (Array.isArray(value) && value.length === 0)) {
          return '*';
        }

        const values = Array.isArray(value) ? value : [value];

        // Sanitize values
        const sanitized = values
          .map(v => this.sanitizeMetricValue(String(v)))
          .filter(v => v !== '');

        if (sanitized.length === 0) {
          return '*'; // Fallback to wildcard if all values were dropped
        }

        if (sanitized.length === 1) {
          return sanitized[0];
        }

        // For multiple values, emit a temporary marker
        return `__IN__(${sanitized.join(', ')})`;
      };

      let replaced = this.templateSrv.replace(preprocessedQueryText, scopedVars, datadogFormat);

      // Rewrite Datadog native multi-select: key:__IN__(a, b) -> key IN (a, b)
      replaced = replaced.replace(/([a-zA-Z0-9_.\-\/]+):__IN__\(([^)]+)\)/g, '$1 IN ($2)');

      // Cleanup leaked markers where IN syntax doesn't apply (e.g. `by {__IN__(a, b)}` -> `by {a, b}`)
      replaced = replaced.replace(/__IN__\(([^)]+)\)/g, '$1');

      return replaced;
    } catch (error) {
      return queryText; // Return original query on error
    }
  }

  /**
   * Interpolates variables in a string with custom formatting support.
   * @param text - The text to interpolate
   * @param scopedVars - Scoped variables for interpolation
   * @returns The interpolated string
   */
  private interpolateString(text: string, scopedVars: ScopedVars): string {
    if (!text) {
      return '';
    }

    try {
      // Handle custom format specifiers like ${variable:format}
      return text.replace(/\$\{([^}:]+):([^}]+)\}/g, (match, varName, format) => {
        const variable = scopedVars[varName] || this.templateSrv.getVariables().find(v => v.name === varName);

        if (!variable) {
          return match; // Return original if variable not found
        }

        const context = this.createInterpolationContext(variable, format as VariableFormat);
        return this.formatMultiValue(context.values, context.format || 'csv');
      }).replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, varName) => {
        // Handle simple variables like $variable
        return this.templateSrv.replace(match, scopedVars);
      });
    } catch (error) {
      return text;
    }
  }

  /**
   * Creates an interpolation context from a variable.
   * @param variable - The variable object
   * @param format - The requested format
   * @returns The interpolation context
   */
  private createInterpolationContext(variable: any, format: VariableFormat): VariableInterpolationContext {
    let values: string[] = [];
    let isMultiValue = false;

    if (variable.current) {
      if (Array.isArray(variable.current.value)) {
        values = variable.current.value.map(String);
        isMultiValue = true;
      } else if (variable.current.value !== null && variable.current.value !== undefined) {
        values = [String(variable.current.value)];
        isMultiValue = false;
      }
    } else if (variable.value !== null && variable.value !== undefined) {
      if (Array.isArray(variable.value)) {
        values = variable.value.map(String);
        isMultiValue = true;
      } else {
        values = [String(variable.value)];
        isMultiValue = false;
      }
    }

    return {
      format,
      values,
      isMultiValue,
    };
  }

  /**
   * Formats multi-value variables according to the specified format.
   * @param values - Array of values to format
   * @param format - The format to apply
   * @returns The formatted string
   */
  formatMultiValue(values: string[], format: VariableFormat = 'csv'): string {
    // Handle empty or undefined values
    if (!values || values.length === 0) {
      return '';
    }

    // Filter out null, undefined, and empty string values
    const filteredValues = values.filter(value =>
      value !== null &&
      value !== undefined &&
      value !== ''
    );

    if (filteredValues.length === 0) {
      return '';
    }

    switch (format) {
      case 'csv':
        return filteredValues.join(',');

      case 'pipe':
        return filteredValues.join('|');

      case 'json':
        return JSON.stringify(filteredValues);

      case 'lucene':
        // Format for Lucene queries: (value1 OR value2 OR value3)
        return `(${filteredValues.map(v => `"${this.escapeLuceneValue(v)}"`).join(' OR ')})`;

      case 'raw':
        // Return the first value for raw format
        return filteredValues[0];

      default:
        // Default to CSV format
        return filteredValues.join(',');
    }
  }

  /**
   * Escapes special characters in Lucene query values.
   * @param value - The value to escape
   * @returns The escaped value
   */
  private escapeLuceneValue(value: string): string {
    // Escape special Lucene characters: + - && || ! ( ) { } [ ] ^ " ~ * ? : \
    return value.replace(/[+\-&|!(){}[\]^"~*?:\\]/g, '\\$&');
  }

  /**
   * Checks if a string contains variable placeholders.
   * @param text - The text to check
   * @returns True if the text contains variables
   */
  hasVariables(text: string): boolean {
    if (!text) {
      return false;
    }

    // Check for both ${variable:format} and $variable patterns
    return /\$\{[^}]+\}|\$[a-zA-Z_][a-zA-Z0-9_]*/.test(text);
  }

  /**
   * Extracts variable names from a text string.
   * @param text - The text to analyze
   * @returns Array of variable names found in the text
   */
  extractVariableNames(text: string): string[] {
    if (!text) {
      return [];
    }

    const variables: string[] = [];

    // Extract from ${variable:format} patterns
    const formatMatches = text.match(/\$\{([^}:]+):[^}]+\}/g);
    if (formatMatches) {
      formatMatches.forEach(match => {
        const varName = match.match(/\$\{([^}:]+):/)?.[1];
        if (varName && !variables.includes(varName)) {
          variables.push(varName);
        }
      });
    }

    // Extract from $variable patterns
    const simpleMatches = text.match(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g);
    if (simpleMatches) {
      simpleMatches.forEach(match => {
        const varName = match.substring(1); // Remove the $
        if (!variables.includes(varName)) {
          variables.push(varName);
        }
      });
    }

    return variables;
  }
}

// Export a singleton instance for use throughout the application
export const variableInterpolationService = new VariableInterpolationService();