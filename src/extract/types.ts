export type HttpMethod = 'get' | 'post' | 'put' | 'delete' | 'patch';

export interface ExtractedOperation {
    operationId: string;
    tag: string;
    sourceFile: string;
    sourceLine: number;
    method: HttpMethod;
    url: string;
    pathParams: ParamDescriptor[];
    queryParams: ParamDescriptor[];
    bodyProperties: ParamDescriptor[];
    bodyKind: 'json' | 'form' | 'none';
    notes: string[];
}

export interface ParamDescriptor {
    name: string;
    typeText: string;
    required: boolean;
}

export interface ExtractedSpec {
    operations: ExtractedOperation[];
    skipped: Array<{ file: string; reason: string }>;
}
