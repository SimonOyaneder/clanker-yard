import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new McpServer({ name: "sentinel", version: "1.0" });
server.registerTool("ping", {}, () => ({ content: [{ type: "text", text: "pong" }] }));
await server.connect(new StdioServerTransport());
