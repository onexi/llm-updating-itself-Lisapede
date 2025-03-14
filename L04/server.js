import express from 'express';
import bodyParser from 'body-parser';
import csvParser from 'csv-parser'; //npm install csv-parser

import { OpenAI} from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from "fs";
import dotenv from 'dotenv';
dotenv.config();

async function searchMemories(query) {
    const memoriesPath = path.resolve(__dirname, "./functions/memories.csv"); // Moved inside function

    return new Promise((resolve) => {
        if (!fs.existsSync(memoriesPath)) {
            console.error("❌ memories.csv file not found.");
            return resolve("No relevant memories found 1.");
        }

        const results = [];
        fs.createReadStream(memoriesPath)
            .pipe(csvParser())
            .on('data', (row) => {
                if (row.memory && row.memory.toLowerCase().includes(query.toLowerCase())) {
                    results.push(row.memory);
                }
            })
            .on('end', () => {
                resolve(results.length ? results.join("\n") : "No relevant memories found 2.");
            });
    });
}

// Initialize Express server
const app = express();
app.use(bodyParser.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.resolve(process.cwd(), './public')));

// OpenAI API configuration
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});
let state = {
    chatgpt:false,
    assistant_id: "",
    assistant_name: "",
    dir_path: "",
    news_path: "",
    thread_id: "",
    user_message: "",
    run_id: "",
    run_status: "",
    vector_store_id: "",
    tools:[],
    parameters: []
  };
// Default route to serve index.html for any undefined routes
app.get('*', (req, res) => {
    res.sendFile(path.resolve(process.cwd(), './public/index.html'));
});
async function getFunctions() {
   
    const files = fs.readdirSync(path.resolve(process.cwd(), "./functions"));
    const openAIFunctions = {};

    for (const file of files) {
        if (file.endsWith(".js")) {
            const moduleName = file.slice(0, -3);
            const modulePath = `./functions/${moduleName}.js`;
            const { details, execute } = await import(modulePath);

            openAIFunctions[moduleName] = {
                "details": details,
                "execute": execute
            };
        }
    }
    return openAIFunctions;
}

// Route to interact with OpenAI API
app.post('/api/execute-function', async (req, res) => {
    const { functionName, parameters } = req.body;

    // Import all functions
    const functions = await getFunctions();

    if (!functions[functionName]) {
        return res.status(404).json({ error: 'Function not found' });
    }

    try {
        // Call the function
        const result = await functions[functionName].execute(...Object.values(parameters));
        console.log(`result: ${JSON.stringify(result)}`);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Function execution failed', details: err.message });
    }
});

// Example to interact with OpenAI API and get function descriptions
app.post('/api/openai-call', async (req, res) => {
    const { user_message } = req.body;

    const functions = await getFunctions();
    const availableFunctions = Object.values(functions).map(fn => fn.details);
    console.log(`availableFunctions: ${JSON.stringify(availableFunctions)}`);

    //let messages = [
    //    { role: 'system', content: 'You are a helpful assistant.' },
    //    { role: 'user', content: user_message }
    //];

    // Search memories for relevant context
    const memoryContext = await searchMemories(user_message);
    console.log(`🔹 Memory Context: ${memoryContext}`);

    // new
    let messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'system', content: `Reference memory: ${memoryContext}` }, // Inject memory context
        { role: 'user', content: user_message }
    ];

    try {
        // Make OpenAI API call
        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: messages,
            tools: availableFunctions
        });
       
       // Extract the arguments for get_delivery_date
// Note this code assumes we have already determined that the model generated a function call. See below for a more production ready example that shows how to check if the model generated a function call
        const toolCall = response.choices[0].message.tool_calls[0];

// Extract the arguments for get_delivery_date
// Note this code assumes we have already determined that the model generated a function call. 
        if (toolCall) {
            const functionName = toolCall.function.name;
            const parameters = JSON.parse(toolCall.function.arguments);

            const result = await functions[functionName].execute(...Object.values(parameters));
// note that we need to respond with the function call result to the model quoting the tool_call_id
            const function_call_result_message = {
                role: "tool",
                content: JSON.stringify({
                    result: result
                }),
                tool_call_id: response.choices[0].message.tool_calls[0].id
            };
            // add to the end of the messages array to send the function call result back to the model
            messages.push(response.choices[0].message);
            messages.push(function_call_result_message);
            const completion_payload = {
                model: "gpt-4o",
                messages: messages,
            };
            // Call the OpenAI API's chat completions endpoint to send the tool call result back to the model
            const final_response = await openai.chat.completions.create({
                model: completion_payload.model,
                messages: completion_payload.messages
            });
            // Extract the output from the final response
            let output = final_response.choices[0].message.content 


            res.json({ message:output, state: state });
        } else {
            res.json({ message: 'No function call detected.' });
        }

    } catch (error) {
        res.status(500).json({ error: 'OpenAI API failed', details: error.message });
    }
});
app.post('/api/prompt', async (req, res) => {
    // just update the state with the new prompt
    state = req.body;
    
    // adding
    //const userMessage = state.user_message || "No message provided";
    const userMessage = req.body.user_message;
    if (!userMessage) {
        console.error("❌ Missing user_message in request");
        return res.status(400).json({ error: "user_message is required" });
    }
    const timestamp = new Date().toISOString();

    // Define file paths
    const memoriesPath = path.resolve(__dirname, "memories.csv");
    const scratchpadPath = path.resolve(__dirname, "scratchpad.js");
    
    // added
    try {
        // Append to memories.csv
        const csvEntry = `"${timestamp}","${userMessage}"\n`;
        fs.appendFileSync(memoriesPath, csvEntry);
        console.log(`✅ Appended to memories.csv: ${csvEntry.trim()}`);

        // Append to scratchpad.js
        const jsEntry = `\n// ${timestamp}\nconst lastUserMessage = "${userMessage}";\n`;
        fs.appendFileSync(scratchpadPath, jsEntry);
        console.log(`✅ Appended to scratchpad.js: ${jsEntry.trim()}`);

        res.status(200).json({ 
            message: `Saved prompt: ${userMessage}`, 
            state: state,
            log: {
                memories: csvEntry.trim(),
                scratchpad: jsEntry.trim()
            }
        });


    // previous code
    //try {
    //    res.status(200).json({ message: `got prompt ${state.user_message}`, "state": state });
    //}
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: 'User Message Failed', "state": state });
    }
});
// Start the server
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
