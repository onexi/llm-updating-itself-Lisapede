import express from 'express';
import bodyParser from 'body-parser';
import csvParser from 'csv-parser'; //npm install csv-parser

import { OpenAI} from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from "fs";
import dotenv from 'dotenv';
dotenv.config();

import { execute as memoryExecute } from "./functions/scratchpad.js";

async function searchMemories(query) {
    try {
        // Retrieve all stored memories
        const memories = await memoryExecute("getall", "", "");
        console.log(`🔹 Retrieved Memories: ${JSON.stringify(memories)}`);

        // Convert query to lowercase and remove punctuation
        const lowerQuery = query.toLowerCase().replace(/[^\w\s]/g, ""); 
        const queryWords = new Set(lowerQuery.split(/\s+/)); // Tokenize query into words

        // Define stopwords to ignore in matching
        const stopwords = new Set(["what", "is", "the", "who", "to", "a"]);

        // Improved filtering logic: Match query with memory keys & values
        const filteredMemories = memories.filter(entry =>
            Object.entries(entry).some(([key, value]) => {
                const lowerKey = key.toLowerCase();
                const lowerValue = value.toLowerCase();

                // Check if query contains the key (e.g., "favorite_food")
                if (queryWords.has(lowerKey)) {
                    return true;
                }

                // Check if memory value contains a key concept from the query
                const memoryWords = new Set(lowerValue.split(/\s+/));
                for (const word of queryWords) {
                    if (!stopwords.has(word) && memoryWords.has(word)) {
                        return true;
                    }
                }

                return false;
            })
        ).filter(entry => !Object.keys(entry)[0].startsWith("user_input_")); // Exclude past queries

        console.log(`🔹 Filtered Relevant Memories: ${JSON.stringify(filteredMemories)}`);

        return filteredMemories.length ? filteredMemories.map(entry => JSON.stringify(entry)).join("\n") : "No relevant memories found.";
    } catch (error) {
        console.error("❌ Error searching memories:", error);
        return "Error retrieving memories.";
    }
}


//previous
//async function searchMemories(query) {
//    const memoriesPath = path.resolve(__dirname, "./functions/memories.csv");

//    return new Promise((resolve) => {
//        if (!fs.existsSync(memoriesPath)) {
//            console.error("❌ memories.csv file not found.");
//            return resolve("No relevant memories found 1.");
//        }

//        const results = [];
//        fs.createReadStream(memoriesPath)
//            .pipe(csvParser())
//            .on('data', (row) => {
//                if (row.memory && row.memory.toLowerCase().includes(query.toLowerCase())) {
//                    results.push(row.memory);
//                }
//            })
//            .on('end', () => {
//               resolve(results.length ? results.join("\n") : "No relevant memories found 2.");
//            });
//    });
//}

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

    let messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'system', content: `Reference memory: ${memoryContext}` }, // ✅ Inject memory context
        { role: 'user', content: user_message }
    ];

    try {
        // Make OpenAI API call
        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: messages,
            tools: availableFunctions
        });

        // Handle function calls
        const toolCalls = response.choices[0].message.tool_calls || [];
        if (toolCalls.length > 0) {
            const toolCall = toolCalls[0]; 
            const functionName = toolCall.function.name;
            const parameters = JSON.parse(toolCall.function.arguments);

            const result = await functions[functionName].execute(...Object.values(parameters));
            
            const function_call_result_message = {
                role: "tool",
                content: JSON.stringify({ result }),
                tool_call_id: toolCall.id
            };

            messages.push(response.choices[0].message);
            messages.push(function_call_result_message);

            const final_response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: messages,
            });

            let output = final_response.choices[0].message.content;
            res.json({ message: output, state: state });
        } else {
            res.json({ message: response.choices[0].message.content });
        }

    } catch (error) {
        res.status(500).json({ error: 'OpenAI API failed', details: error.message });
    }
});


app.post('/api/prompt', async (req, res) => {
    state = req.body;
    
    const userMessage = req.body.user_message;
    if (!userMessage) {
        console.error("❌ Missing user_message in request");
        return res.status(400).json({ error: "user_message is required" });
    }

    const timestamp = new Date().toISOString();
    const key = `user_input_${timestamp}`; // Generate a unique key

    try {
        // Use `scratchpad.js` to store the memory
        await memoryExecute("set", key, userMessage);
        console.log(`✅ Memory stored via scratchpad.js: ${key} -> ${userMessage}`);

        res.status(200).json({ 
            message: `Saved prompt: ${userMessage}`, 
            state: state,
            log: { stored_key: key, stored_memory: userMessage }
        });
    } catch (error) {
        console.error("❌ Error storing memory:", error);
        res.status(500).json({ error: "User Message Failed", state: state });
    }
});


// Start the server
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
