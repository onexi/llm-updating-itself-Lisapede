import express from 'express';
import bodyParser from 'body-parser';
import { OpenAI} from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from "fs";
import dotenv from 'dotenv';
dotenv.config();

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

    // debug
    console.log("Received function call:", functionName);
    console.log("Raw parameters received:", parameters);

    // Import all functions
    const functions = await getFunctions();
    console.log("🔹 Loaded Functions:", Object.keys(functions));


    //    console.log("Loaded Functions:", JSON.stringify(functions, null, 2));

    if (!functions[functionName]) {
        console.error(`Function ${functionName} not found`); //added 
        return res.status(404).json({ error: 'Function not found' });
    }

    try {
        
        // added to try to debug
        // ✅ Fix: Ensure parameters are parsed correctly
        const parsedParameters = typeof parameters === "string" ? JSON.parse(parameters) : parameters;
        console.log("🔹 Parsed Parameters:", parsedParameters);

        if (functionName === "greetUser") {
            if (!parsedParameters || !parsedParameters.name) {
                console.error("❌ Missing 'name' parameter for greetUser.");
                return res.status(400).json({ error: "Missing 'name' parameter", received: parsedParameters });
            }
            console.log("✅ Executing greetUser with name:", parsedParameters.name);
        }
        // ✅ Fix: Ensure correct function execution
        const result = functionName === "greetUser"
            ? await functions[functionName].execute(parsedParameters.name)
            : await functions[functionName].execute(...Object.values(parsedParameters));

        console.log(`🔹 Executed Function: ${functionName}, Result: ${JSON.stringify(result)}`);

        res.json({
            message: "Function executed successfully",
            json_output: result,  
            functions: Object.keys(functions),  
            state: state
        });
        
        // Call the function
        // const result = await functions[functionName].execute(...Object.values(parameters));
        // console.log(`result: ${JSON.stringify(result)}`);
        
        //res.json(result);
        
        res.json({
            message: "Function executed successfully",
            json_output: result,  // ✅ Send function result to UI
            functions: Object.keys(functions),  // ✅ Send available function names
            state: state
        });
        
        // res.json({ message: "JSON Output", result: result });

        // added to test json_output
        //res.json({
        //    message: "Function executed successfully",
        //    json_output: result, // Ensure the UI can pick this up
        //   functions
        // });
    } catch (err) {
        res.status(500).json({ error: 'Function execution failed', details: err.message });
    }

    // added fetch to test json_output
    // this does not seem to work
    // fetch('/api/execute-function', {
    //    method: 'POST',
    //    headers: { 'Content-Type': 'application/json' },
    //    body: JSON.stringify({
    //        functionName: selectedFunction,
    //        parameters: JSON.parse(parametersInput.value)
    //    })
   // })
    //.then(response => response.json())
    //.then(data => {
    //    console.log("🔹 Server Response:", data); // Debugging
    
    ///    document.getElementById("json-output").value = JSON.stringify(data.json_output, null, 2); // Ensure JSON Output textbox updates
    //    document.getElementById("functions").value = JSON.stringify(data.functions, null, 2); // Ensure Functions textbox updates
    //})
    //.catch(error => console.error('Error:', error));
});

// Example to interact with OpenAI API and get function descriptions
app.post('/api/openai-call', async (req, res) => {
    const { user_message } = req.body;

    const functions = await getFunctions();
    const availableFunctions = Object.values(functions).map(fn => fn.details);
    console.log(`availableFunctions: ${JSON.stringify(availableFunctions)}`);
    let messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
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

            // This is where the code gets outputted to the Agent Context Window 
            //res.json({ message:output, state: state });

            res.json({
                message: output,
                json_output: result,  // Ensure the UI gets the function result
                functions: Object.keys(functions),  // Send function names
                state: state
            });
        } else {
            res.json({ message: 'No function call detected.' });
        }

    } catch (error) {
        res.status(500).json({ error: 'OpenAI API failed', details: error.message });
    }
});

// this is what gets added into the Agent Context Window 
app.post('/api/prompt', async (req, res) => {
    // just update the state with the new prompt
    state = req.body;
    try {
        res.status(200).json({ message: `got prompt ${state.user_message}`, "state": state });
    }
    catch (error) {
        console.log(error);
        res.status(500).json({ message: 'User Message Failed', "state": state });
    }
});
// Start the server
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
