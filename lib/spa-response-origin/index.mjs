import path from "path";

export async function handler(event, context, callback) {
    const config = event.Records[0].cf;
    const request = event.Records[0].cf.request;
    const response = event.Records[0].cf.response;

    // only log on error
    console.info('Received response', {
        variables: {
            ip: request.clientIp,
            method: request.method,
            uri: request.uri,
            headers: { ...request.headers },
            responseStatusCode: response.status,
            awsRequestId: context.awsRequestId,
        },
    });

    if(response.status === 404 || response.status === 403) {
        response.uri = response.uri.split('/')[0] + '/index.html';
        return callback(null, response);
    }


    return callback(null, response);
}
