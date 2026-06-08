declare module 'fit-file-parser' {
  interface FitParserOptions {
    force?: boolean;
    speedUnit?: 'km/h' | 'mph' | 'm/s';
    lengthUnit?: 'km' | 'mi' | 'm';
    temperatureUnit?: 'celsius' | 'kelvin' | 'fahrenheit';
    elapsedRecordField?: boolean;
    mode?: 'list' | 'cascade' | 'both';
  }

  interface FitData {
    sessions?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  }

  export default class FitParser {
    constructor(options?: FitParserOptions);
    parse(content: Buffer | ArrayBuffer | Uint8Array, callback: (error: string | null, data: FitData) => void): void;
  }
}
