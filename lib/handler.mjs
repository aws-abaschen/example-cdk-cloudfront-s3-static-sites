function handler(event) {
    const request = event.request;
    request.uri = request.uri.replace(/^\/sub-site\//, "/");
    return request;
}

const lens = {
    "schemaVersion": "2021-11-01",
    "name": "Replace with lens name",
    "description": "Replace with your description",
    "pillars": [
        {
            "id": "pillar_id_1", "name": "Pillar 1", "questions": [
                {
                    "id": "pillar_1_q1", "title": "My first question", "description": "Describes the question in more detail. The description can be up to 2048 characters.",
                    "choices": [
                        {
                            "id": "choice1", "title": "Best practice #1", "helpfulResource": { "displayText": "It's recommended that you include a helpful resource text and URL for each choice for your users.", "url": "https://aws.amazon.com" },
                            "improvementPlan": { "displayText": "You must have improvement plans per choice. It's optional whether or not to have a corresponding URL." }
                        }, {
                            "id": "choice2", "title": "Best practice #2", "helpfulResource": { "displayText": "It's recommended that you include a helpful resource text and URL for each choice for your users.", "url": "https://aws.amazon.com" }, "improvementPlan": { "displayText": "You must have improvement plans per choice. It's optional whether or not to have a corresponding URL." }
                        }
                    ],
                    "riskRules": [
                        { "condition": "choice1 && choice2", "risk": "NO_RISK" }, 
                        { "condition": "choice1 && !choice2", "risk": "MEDIUM_RISK" },                        
                        { "condition": "default", "risk": "HIGH_RISK" }]
                }]
        }
    ]
};