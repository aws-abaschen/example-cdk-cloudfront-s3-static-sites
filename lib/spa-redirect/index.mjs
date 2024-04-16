import { get } from 'http';
const INDEX_PAGE = 'index.html';

/**
 * Lambda's handler function.
 * @param event CloudFront origin response event
 * @param context When Lambda runs your function, it passes a context object to the handler.
 * This object provides methods and properties that provide information about the invocation,
 * function, and execution environment.
 * @returns a promise
 */
export async function handler(event, context, callback) {
    const config = event.Records[0].cf;
    const request = event.Records[0].cf.request;
    const response = event.Records[0].cf.response;

    // only log on error
    if (parseInt(response.status) >= 400) {
        console.info('Received request', {
            variables: {
                ip: request.clientIp,
                method: request.method,
                uri: request.uri,
                headers: { ...request.headers },
                responseStatus: response.status,
                awsRequestId: context.awsRequestId,
            },
        });
    }

    // Only replace 403 and 404 requests typically received when loading a page for a SPA that uses client-side routing
    if (request.method === 'GET' && (response.status == '403' || response.status == '404')) {
        const result = await generateResponseAndLog(config.config.distributionDomainName, request);
        console.info('Response was regenerated', {
            variables: {
                status: result.status,
                path: result.path,
                headers: { ...result.headers },
            },
        });
        return result;
    }

    return response;
}

async function httpGet(params) {
    return new Promise((resolve, reject) => {
        get(params, (resp) => {
            console.log(`Fetching ${params.hostname}${params.path}, status code : ${resp.statusCode}`);
            let data = '';
            resp.on('data', (chunk) => { data += chunk; });
            resp.on('end', () => { resolve(data); });
        }).on('error', (err) => {
            console.log(`Couldn't fetch ${params.hostname}${params.path} : ${err.message}`);
            reject(err, null);
        });
    });
}


/**
 * This function will make an https request on cloudfront/indexPath to load the angular application
 * @param distributionDomainName distributionDomainName domain of the cloudfront distribution
 * @param request cloudfront request
 * @returns a custom response
 */
async function generateResponseAndLog(
    distributionDomainName,
    request
) {
    const indexPath = getIndexPath(request);

    const url = `https://${distributionDomainName}${indexPath}`;
    console.debug('HTTP GET', { variables: { url: url } });

    let response;
    try {
        // the specific x-lambda-origin-request header can be used by other functions to know
        // that the request is coming from this lambda
        response = await httpGet(url, { headers: { 'x-lambda-origin-request': 'axios-angular-lambda' } });
    } catch (error) {
        console.error('Error happened', { error: { ...error } });

        return {
            status: '500',
            headers: {
                'content-type': [{ value: 'text/plain' }],
            },
            body: 'An error occurred loading the page',
            path: indexPath,
        };
    }

    console.debug('HTTP GET successful', {
        variables: {
            requestUrl: url,
            status: response.status,
            headers: response.headers,
            body: response.data,
        },
    });

    return {
        status: `${response.status}`,
        headers: filterHeaders(response.headers),
        body: response.data,
        path: indexPath,
    };
}

/**
 * Filter header returned by the origin to only an allowed subset
 * @param headers the headers
 * @returns filtered headers
 */
function filterHeaders(headers) {
    const allowedHeaders = [
        'content-type',
        'content-length',
        'content-encoding',
        'transfer-encoding',
        'last-modified',
        'date',
        'etag',
    ];

    const responseHeaders = {};

    // only include allowed headers
    if (headers) {
        for (const headerName in headers) {
            if (allowedHeaders.includes(headerName.toLowerCase())) {
                responseHeaders[headerName] = [{ key: headerName, value: headers[headerName] }];
            }
        }
    }

    return responseHeaders;
}

/**
 * Get the root segment of the request URI. Per example
 * /en -> en
 * /it/foo/bar -> it
 * And localize it. ie return a supported language prefix.
 * @param request cloudfront request
 * @returns localized path to the index file
 */
function getIndexPath(request) {
    let requestUri = request.uri;

    // removes / when it's the first character of the string
    if (requestUri.startsWith('/')) {
        requestUri = requestUri.slice(1);
    }

    // only process first part of the path and localize it
    const appPath = requestUri.split('/')[0];

    let indexPath = `${appPath}/${this.INDEX_PAGE}`;
    // makes sure indexPath starts with a /
    if (!indexPath.startsWith('/')) {
        indexPath = `/${indexPath}`;
    }

    return indexPath;
}

