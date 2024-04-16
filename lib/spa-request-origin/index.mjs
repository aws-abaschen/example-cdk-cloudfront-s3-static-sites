import path from "path";

export async function handler(event, context, callback) {
    const config = event.Records[0].cf;
    const request = event.Records[0].cf.request;

    // only log on error
    console.info('Received request', {
        variables: {
            ip: request.clientIp,
            method: request.method,
            uri: request.uri,
            headers: { ...request.headers },
            awsRequestId: context.awsRequestId,
        },
    });

    if(path.parse(request.uri).ext === '')
        request.uri = request.uri.split('/')[0] + '/index.html';

    return callback(null, request);
}
