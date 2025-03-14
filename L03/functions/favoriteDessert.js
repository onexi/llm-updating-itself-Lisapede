const execute = async (dessert) => {
    console.log("🔹 Received Dessert name:", dessert); // Debugging
    return { greeting: `Your favorite dessert is ${dessert}!` };
};

const details = {
    type: "function",
    function: {
        name: "favoriteDessert",
        parameters: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    description: "Name of the user's favorite dessert"
                }
            },
            required: ["dessert"]
        }
    },
    description: 'This function returns the users favorite dessert.'
};

export { execute, details };
