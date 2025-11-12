#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { randomUUID } from "crypto";

const WS_PORT = 3000;
const REQUEST_TIMEOUT = 5000; // 5 seconds

// ============================================================================
// TypeScript Interfaces for WebSocket Protocol
// ============================================================================

/**
 * Request sent from MCP server to Figma plugin
 */
interface FigmaToolRequest {
  id: string;
  type: "tool_request";
  tool: string;
  args: Record<string, any>;
}

/**
 * Response sent from Figma plugin to MCP server
 */
interface FigmaToolResponse {
  id: string;
  type: "tool_response";
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Event sent from Figma plugin to MCP server (future use)
 */
interface FigmaEvent {
  type: "event";
  event: string;
  data: any;
}

/**
 * Union type for all WebSocket messages
 */
type WebSocketMessage = FigmaToolRequest | FigmaToolResponse | FigmaEvent;

/**
 * Pending request tracking
 */
interface PendingRequest {
  id: string;
  toolName: string;
  timestamp: number;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

// ============================================================================
// Server State Management
// ============================================================================

/**
 * Global server state
 */
const serverState = {
  figmaConnection: null as WebSocket | null,
  pendingRequests: new Map<string, PendingRequest>(),
  isConnected: false,
};

/**
 * Check if Figma plugin is connected
 */
function isFigmaConnected(): boolean {
  return serverState.figmaConnection !== null &&
         serverState.figmaConnection.readyState === WebSocket.OPEN;
}

// ============================================================================
// Tool-to-WebSocket Bridge
// ============================================================================

/**
 * Send a tool request to Figma plugin and wait for response
 * @param toolName - Name of the tool to execute
 * @param args - Tool arguments
 * @returns Promise that resolves with the tool response data
 * @throws Error if Figma is not connected or request times out
 */
async function sendToFigma(toolName: string, args: Record<string, any>): Promise<any> {
  // Check connection
  if (!isFigmaConnected()) {
    throw new Error("Figma plugin is not connected. Please open Figma and run the MCP plugin.");
  }

  // Generate unique request ID
  const requestId = randomUUID();

  // Create promise that will be resolved when response arrives
  return new Promise((resolve, reject) => {
    // Set up timeout
    const timeout = setTimeout(() => {
      // Clean up
      serverState.pendingRequests.delete(requestId);
      reject(new Error(`Request timeout: Figma did not respond within ${REQUEST_TIMEOUT}ms`));
    }, REQUEST_TIMEOUT);

    // Store pending request
    serverState.pendingRequests.set(requestId, {
      id: requestId,
      toolName,
      timestamp: Date.now(),
      resolve,
      reject,
      timeout,
    });

    // Send request to Figma via WebSocket
    const request: FigmaToolRequest = {
      id: requestId,
      type: "tool_request",
      tool: toolName,
      args,
    };

    try {
      serverState.figmaConnection!.send(JSON.stringify(request));
      console.error(`Sent tool request to Figma: ${toolName} (id: ${requestId})`);
    } catch (error) {
      // Clean up on send error
      clearTimeout(timeout);
      serverState.pendingRequests.delete(requestId);
      reject(new Error(`Failed to send request to Figma: ${error}`));
    }
  });
}

/**
 * Handle response from Figma plugin
 * @param response - Tool response from Figma
 */
function handleFigmaResponse(response: FigmaToolResponse): void {
  const pending = serverState.pendingRequests.get(response.id);

  if (!pending) {
    console.error(`Received response for unknown request: ${response.id}`);
    return;
  }

  // Clean up timeout
  clearTimeout(pending.timeout);
  serverState.pendingRequests.delete(response.id);

  // Resolve or reject the promise
  if (response.success) {
    console.error(`Tool ${pending.toolName} succeeded (id: ${response.id})`);
    pending.resolve(response.data);
  } else {
    console.error(`Tool ${pending.toolName} failed: ${response.error} (id: ${response.id})`);
    pending.reject(new Error(response.error || "Unknown error from Figma"));
  }
}

// Create MCP server instance
const server = new Server(
  {
    name: "figma-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "ping",
        description: "Test the MCP server connection. Returns a pong message with timestamp.",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Optional message to echo back"
            }
          }
        }
      },
      {
        name: "get_selection",
        description: "Get information about currently selected Figma nodes. Returns details like ID, name, type, position, and dimensions.",
        inputSchema: {
          type: "object",
          properties: {
            includeChildren: {
              type: "boolean",
              description: "Include child nodes in the response (default: false)"
            }
          }
        }
      },
      {
        name: "set_selection",
        description: "Select specific Figma nodes by their IDs. This changes the current selection in Figma.",
        inputSchema: {
          type: "object",
          properties: {
            nodeIds: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Array of node IDs to select (e.g., ['1:234', '1:235'])"
            }
          },
          required: ["nodeIds"]
        }
      },
      {
        name: "scan_frame",
        description: "Get all child nodes of a frame or container. Useful for discovering the structure of a design.",
        inputSchema: {
          type: "object",
          properties: {
            frameId: {
              type: "string",
              description: "Frame ID to scan. If omitted, scans the first selected frame."
            },
            depth: {
              type: "number",
              description: "How many levels deep to scan (default: 1, max: 5)"
            },
            filter: {
              type: "string",
              description: "Filter by node type (e.g., 'TEXT', 'FRAME', 'RECTANGLE')"
            }
          }
        }
      },
      {
        name: "find_nodes",
        description: "Search for nodes matching specific criteria (name, type, visibility, etc.)",
        inputSchema: {
          type: "object",
          properties: {
            searchTerm: {
              type: "string",
              description: "Text to search for in node names"
            },
            nodeType: {
              type: "string",
              description: "Filter by node type (e.g., 'TEXT', 'FRAME', 'RECTANGLE')"
            },
            visibleOnly: {
              type: "boolean",
              description: "Only return visible nodes (default: false)"
            },
            searchScope: {
              type: "string",
              description: "Where to search: 'page' (current page), 'selection' (within selected nodes), or nodeId"
            }
          }
        }
      },
      {
        name: "get_node_properties",
        description: "Get detailed properties of specific node(s) including position, size, fills, strokes, effects, and more.",
        inputSchema: {
          type: "object",
          properties: {
            nodeIds: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Array of node IDs to get properties for"
            }
          },
          required: ["nodeIds"]
        }
      },
      {
        name: "get_text_content",
        description: "Read text content and styling from text nodes. Returns the text, font, size, and alignment.",
        inputSchema: {
          type: "object",
          properties: {
            nodeIds: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Array of text node IDs to read from. If omitted, reads from selected text nodes."
            }
          }
        }
      },
      {
        name: "set_text_content",
        description: "Update text content in text nodes. Preserves existing formatting.",
        inputSchema: {
          type: "object",
          properties: {
            nodeId: {
              type: "string",
              description: "ID of the text node to update"
            },
            text: {
              type: "string",
              description: "New text content"
            }
          },
          required: ["nodeId", "text"]
        }
      },
      {
        name: "create_text_node",
        description: "Create a new text layer in Figma with specified content and styling.",
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Text content for the new node"
            },
            x: {
              type: "number",
              description: "X position (optional, defaults to 0)"
            },
            y: {
              type: "number",
              description: "Y position (optional, defaults to 0)"
            },
            fontSize: {
              type: "number",
              description: "Font size (optional, defaults to 16)"
            },
            fontFamily: {
              type: "string",
              description: "Font family name (optional, defaults to 'Inter')"
            },
            fontStyle: {
              type: "string",
              description: "Font style (optional, defaults to 'Regular')"
            },
            parentId: {
              type: "string",
              description: "Parent node ID to add the text to (optional, adds to current page if not specified)"
            }
          },
          required: ["text"]
        }
      },
      {
        name: "rename_node",
        description: "Change the name of one or more nodes. Supports bulk renaming with pattern.",
        inputSchema: {
          type: "object",
          properties: {
            nodeIds: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Array of node IDs to rename"
            },
            newName: {
              type: "string",
              description: "New name for the node(s). For bulk rename, use {index} placeholder (e.g., 'Item {index}')"
            }
          },
          required: ["nodeIds", "newName"]
        }
      },
      {
        name: "set_node_visibility",
        description: "Show or hide nodes in Figma.",
        inputSchema: {
          type: "object",
          properties: {
            nodeIds: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Array of node IDs to modify"
            },
            visible: {
              type: "boolean",
              description: "true to show, false to hide"
            }
          },
          required: ["nodeIds", "visible"]
        }
      },
      {
        name: "set_node_lock",
        description: "Lock or unlock nodes to prevent/allow editing.",
        inputSchema: {
          type: "object",
          properties: {
            nodeIds: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Array of node IDs to modify"
            },
            locked: {
              type: "boolean",
              description: "true to lock, false to unlock"
            }
          },
          required: ["nodeIds", "locked"]
        }
      }
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "ping") {
      // Test the full round-trip: Claude → MCP → WebSocket → Figma → WebSocket → MCP → Claude
      const message = (args as any)?.message || "Hello from Claude Desktop!";

      // Send request to Figma
      const result = await sendToFigma("ping", { message });

      return {
        content: [
          {
            type: "text",
            text: `🏓 PONG! Full round-trip successful!\n\n` +
                  `Your message: "${message}"\n` +
                  `Figma response: ${result.message}\n` +
                  `Figma timestamp: ${result.timestamp}\n` +
                  `Figma version: ${result.figmaVersion}\n` +
                  `MCP Server: figma-mcp-server v1.0.0`
          }
        ]
      };
    }

    if (name === "get_selection") {
      // Get currently selected nodes in Figma
      const includeChildren = (args as any)?.includeChildren || false;

      // Send request to Figma
      const result = await sendToFigma("get_selection", { includeChildren });

      // Format response
      if (result.selection.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No nodes are currently selected in Figma.\n\nPlease select one or more nodes and try again."
            }
          ]
        };
      }

      // Build formatted text response
      let responseText = `Selected ${result.selection.length} node${result.selection.length > 1 ? 's' : ''}:\n\n`;

      result.selection.forEach((node: any, index: number) => {
        responseText += `${index + 1}. **${node.name}** (${node.type})\n`;
        responseText += `   - ID: ${node.id}\n`;
        if (node.x !== undefined && node.y !== undefined) {
          responseText += `   - Position: (${Math.round(node.x)}, ${Math.round(node.y)})\n`;
        }
        if (node.width !== undefined && node.height !== undefined) {
          responseText += `   - Size: ${Math.round(node.width)} × ${Math.round(node.height)}\n`;
        }
        responseText += `   - Visible: ${node.visible ? 'Yes' : 'No'}\n`;
        responseText += `   - Locked: ${node.locked ? 'Yes' : 'No'}\n`;

        if (node.type === 'TEXT' && node.characters) {
          responseText += `   - Text: "${node.characters.substring(0, 50)}${node.characters.length > 50 ? '...' : ''}"\n`;
        }

        if (includeChildren && node.children && node.children.length > 0) {
          responseText += `   - Children: ${node.children.length} child node${node.children.length > 1 ? 's' : ''}\n`;
        }

        responseText += '\n';
      });

      return {
        content: [
          {
            type: "text",
            text: responseText.trim()
          }
        ]
      };
    }

    if (name === "set_selection") {
      // Select specific nodes by ID
      const nodeIds = (args as any)?.nodeIds;

      if (!nodeIds || !Array.isArray(nodeIds) || nodeIds.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: nodeIds parameter is required and must be a non-empty array of node IDs."
            }
          ],
          isError: true
        };
      }

      // Send request to Figma
      const result = await sendToFigma("set_selection", { nodeIds });

      // Format response
      let responseText = `Selection updated successfully!\n\n`;
      responseText += `Selected ${result.selectedCount} of ${nodeIds.length} requested node${nodeIds.length > 1 ? 's' : ''}:\n\n`;

      result.selected.forEach((node: any, index: number) => {
        responseText += `${index + 1}. **${node.name}** (${node.type}) - ID: ${node.id}\n`;
      });

      if (result.notFound && result.notFound.length > 0) {
        responseText += `\n⚠️  ${result.notFound.length} node${result.notFound.length > 1 ? 's' : ''} not found:\n`;
        result.notFound.forEach((id: string) => {
          responseText += `   - ${id}\n`;
        });
      }

      return {
        content: [
          {
            type: "text",
            text: responseText
          }
        ]
      };
    }

    if (name === "scan_frame") {
      // Scan a frame and get its children
      const frameId = (args as any)?.frameId;
      const depth = Math.min((args as any)?.depth || 1, 5); // Cap at 5 levels
      const filter = (args as any)?.filter;

      // Send request to Figma
      const result = await sendToFigma("scan_frame", { frameId, depth, filter });

      // Format response
      let responseText = `**Frame: ${result.frameName}** (${result.frameType})\n`;
      responseText += `ID: ${result.frameId}\n\n`;

      if (result.children.length === 0) {
        responseText += "This frame has no children.";
      } else {
        responseText += `Found ${result.children.length} child node${result.children.length > 1 ? 's' : ''}`;
        if (filter) {
          responseText += ` (filtered by type: ${filter})`;
        }
        responseText += `:\n\n`;

        result.children.forEach((node: any, index: number) => {
          const indent = '  '.repeat(node.level || 0);
          responseText += `${indent}${index + 1}. **${node.name}** (${node.type})\n`;
          responseText += `${indent}   - ID: ${node.id}\n`;
          if (node.width !== undefined) {
            responseText += `${indent}   - Size: ${Math.round(node.width)} × ${Math.round(node.height)}\n`;
          }
          if (node.type === 'TEXT' && node.characters) {
            responseText += `${indent}   - Text: "${node.characters.substring(0, 40)}${node.characters.length > 40 ? '...' : ''}"\n`;
          }
          if (node.childCount) {
            responseText += `${indent}   - Children: ${node.childCount}\n`;
          }
        });
      }

      return {
        content: [
          {
            type: "text",
            text: responseText
          }
        ]
      };
    }

    if (name === "find_nodes") {
      // Search for nodes matching criteria
      const searchTerm = (args as any)?.searchTerm;
      const nodeType = (args as any)?.nodeType;
      const visibleOnly = (args as any)?.visibleOnly || false;
      const searchScope = (args as any)?.searchScope || 'page';

      // Send request to Figma
      const result = await sendToFigma("find_nodes", {
        searchTerm,
        nodeType,
        visibleOnly,
        searchScope
      });

      // Format response
      let responseText = `**Search Results**\n\n`;

      if (searchTerm) responseText += `Search term: "${searchTerm}"\n`;
      if (nodeType) responseText += `Node type: ${nodeType}\n`;
      if (visibleOnly) responseText += `Visible only: Yes\n`;
      responseText += `Search scope: ${searchScope}\n\n`;

      if (result.results.length === 0) {
        responseText += "No nodes found matching the criteria.";
      } else {
        responseText += `Found ${result.results.length} matching node${result.results.length > 1 ? 's' : ''}:\n\n`;

        result.results.forEach((node: any, index: number) => {
          responseText += `${index + 1}. **${node.name}** (${node.type})\n`;
          responseText += `   - ID: ${node.id}\n`;
          if (node.parent) {
            responseText += `   - Parent: ${node.parent.name}\n`;
          }
          if (node.width !== undefined) {
            responseText += `   - Size: ${Math.round(node.width)} × ${Math.round(node.height)}\n`;
          }
          if (node.type === 'TEXT' && node.characters) {
            responseText += `   - Text: "${node.characters.substring(0, 40)}${node.characters.length > 40 ? '...' : ''}"\n`;
          }
          responseText += '\n';
        });
      }

      return {
        content: [
          {
            type: "text",
            text: responseText.trim()
          }
        ]
      };
    }

    if (name === "get_node_properties") {
      // Get detailed properties of nodes
      const nodeIds = (args as any)?.nodeIds;

      if (!nodeIds || !Array.isArray(nodeIds) || nodeIds.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: nodeIds parameter is required and must be a non-empty array."
            }
          ],
          isError: true
        };
      }

      // Send request to Figma
      const result = await sendToFigma("get_node_properties", { nodeIds });

      // Format response
      let responseText = `**Node Properties** (${result.nodes.length} node${result.nodes.length > 1 ? 's' : ''})\n\n`;

      result.nodes.forEach((node: any, index: number) => {
        responseText += `**${index + 1}. ${node.name}** (${node.type})\n`;
        responseText += `   - ID: ${node.id}\n`;

        if (node.x !== undefined) {
          responseText += `   - Position: (${Math.round(node.x)}, ${Math.round(node.y)})\n`;
        }
        if (node.width !== undefined) {
          responseText += `   - Size: ${Math.round(node.width)} × ${Math.round(node.height)}\n`;
        }
        if (node.rotation !== undefined && node.rotation !== 0) {
          responseText += `   - Rotation: ${node.rotation}°\n`;
        }

        responseText += `   - Visible: ${node.visible ? 'Yes' : 'No'}\n`;
        responseText += `   - Locked: ${node.locked ? 'Yes' : 'No'}\n`;

        if (node.opacity !== undefined && node.opacity !== 1) {
          responseText += `   - Opacity: ${Math.round(node.opacity * 100)}%\n`;
        }

        if (node.fills && node.fills.length > 0) {
          responseText += `   - Fills: ${node.fills.length} fill${node.fills.length > 1 ? 's' : ''}\n`;
        }

        if (node.strokes && node.strokes.length > 0) {
          responseText += `   - Strokes: ${node.strokes.length} stroke${node.strokes.length > 1 ? 's' : ''}\n`;
        }

        if (node.effects && node.effects.length > 0) {
          responseText += `   - Effects: ${node.effects.length} effect${node.effects.length > 1 ? 's' : ''}\n`;
        }

        if (node.parent) {
          responseText += `   - Parent: ${node.parent.name} (${node.parent.type})\n`;
        }

        if (node.childCount) {
          responseText += `   - Children: ${node.childCount}\n`;
        }

        if (node.type === 'TEXT') {
          if (node.characters) {
            responseText += `   - Text: "${node.characters.substring(0, 60)}${node.characters.length > 60 ? '...' : ''}"\n`;
          }
          if (node.fontSize) {
            responseText += `   - Font Size: ${node.fontSize}\n`;
          }
          if (node.fontName) {
            responseText += `   - Font: ${node.fontName.family} ${node.fontName.style}\n`;
          }
        }

        responseText += '\n';
      });

      if (result.notFound && result.notFound.length > 0) {
        responseText += `⚠️  ${result.notFound.length} node${result.notFound.length > 1 ? 's' : ''} not found:\n`;
        result.notFound.forEach((id: string) => {
          responseText += `   - ${id}\n`;
        });
      }

      return {
        content: [
          {
            type: "text",
            text: responseText.trim()
          }
        ]
      };
    }

    if (name === "get_text_content") {
      // Get text content from text nodes
      const nodeIds = (args as any)?.nodeIds;

      // Send request to Figma
      const result = await sendToFigma("get_text_content", { nodeIds });

      // Format response
      if (result.textNodes.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No text nodes found. Either specify node IDs or select text nodes in Figma."
            }
          ]
        };
      }

      let responseText = `**Text Content** (${result.textNodes.length} text node${result.textNodes.length > 1 ? 's' : ''})\n\n`;

      result.textNodes.forEach((node: any, index: number) => {
        responseText += `**${index + 1}. ${node.name}**\n`;
        responseText += `   - ID: ${node.id}\n`;
        responseText += `   - Text: "${node.characters}"\n`;
        responseText += `   - Font: ${node.fontName.family} ${node.fontName.style}\n`;
        responseText += `   - Size: ${node.fontSize}px\n`;
        responseText += `   - Alignment: ${node.textAlignHorizontal}\n`;
        responseText += '\n';
      });

      return {
        content: [
          {
            type: "text",
            text: responseText.trim()
          }
        ]
      };
    }

    if (name === "set_text_content") {
      // Update text content
      const nodeId = (args as any)?.nodeId;
      const text = (args as any)?.text;

      if (!nodeId || !text) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Both nodeId and text parameters are required."
            }
          ],
          isError: true
        };
      }

      // Send request to Figma
      const result = await sendToFigma("set_text_content", { nodeId, text });

      // Format response
      let responseText = `Text updated successfully!\n\n`;
      responseText += `**${result.nodeName}**\n`;
      responseText += `   - ID: ${result.nodeId}\n`;
      responseText += `   - New text: "${result.newText}"\n`;
      responseText += `   - Previous text: "${result.previousText}"\n`;
      responseText += `   - Font: ${result.fontName.family} ${result.fontName.style}\n`;

      return {
        content: [
          {
            type: "text",
            text: responseText
          }
        ]
      };
    }

    if (name === "create_text_node") {
      // Create new text node
      const text = (args as any)?.text;
      const x = (args as any)?.x || 0;
      const y = (args as any)?.y || 0;
      const fontSize = (args as any)?.fontSize || 16;
      const fontFamily = (args as any)?.fontFamily || 'Inter';
      const fontStyle = (args as any)?.fontStyle || 'Regular';
      const parentId = (args as any)?.parentId;

      if (!text) {
        return {
          content: [
            {
              type: "text",
              text: "Error: text parameter is required."
            }
          ],
          isError: true
        };
      }

      // Send request to Figma
      const result = await sendToFigma("create_text_node", {
        text,
        x,
        y,
        fontSize,
        fontFamily,
        fontStyle,
        parentId
      });

      // Format response
      let responseText = `Text node created successfully!\n\n`;
      responseText += `**${result.nodeName}**\n`;
      responseText += `   - ID: ${result.nodeId}\n`;
      responseText += `   - Text: "${result.text}"\n`;
      responseText += `   - Position: (${Math.round(result.x)}, ${Math.round(result.y)})\n`;
      responseText += `   - Font: ${result.fontName.family} ${result.fontName.style}\n`;
      responseText += `   - Size: ${result.fontSize}px\n`;
      if (result.parentName) {
        responseText += `   - Parent: ${result.parentName}\n`;
      }

      return {
        content: [
          {
            type: "text",
            text: responseText
          }
        ]
      };
    }

    if (name === "rename_node") {
      // Rename nodes
      const nodeIds = (args as any)?.nodeIds;
      const newName = (args as any)?.newName;

      if (!nodeIds || !Array.isArray(nodeIds) || nodeIds.length === 0 || !newName) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Both nodeIds (array) and newName (string) parameters are required."
            }
          ],
          isError: true
        };
      }

      // Send request to Figma
      const result = await sendToFigma("rename_node", { nodeIds, newName });

      // Format response
      let responseText = `Renamed ${result.renamed.length} node${result.renamed.length > 1 ? 's' : ''} successfully!\n\n`;

      result.renamed.forEach((node: any, index: number) => {
        responseText += `${index + 1}. **${node.newName}**\n`;
        responseText += `   - ID: ${node.id}\n`;
        responseText += `   - Previous name: "${node.oldName}"\n`;
        responseText += `   - Type: ${node.type}\n`;
        responseText += '\n';
      });

      if (result.notFound && result.notFound.length > 0) {
        responseText += `⚠️  ${result.notFound.length} node${result.notFound.length > 1 ? 's' : ''} not found:\n`;
        result.notFound.forEach((id: string) => {
          responseText += `   - ${id}\n`;
        });
      }

      return {
        content: [
          {
            type: "text",
            text: responseText.trim()
          }
        ]
      };
    }

    if (name === "set_node_visibility") {
      // Set visibility of nodes
      const nodeIds = (args as any)?.nodeIds;
      const visible = (args as any)?.visible;

      if (!nodeIds || !Array.isArray(nodeIds) || nodeIds.length === 0 || visible === undefined) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Both nodeIds (array) and visible (boolean) parameters are required."
            }
          ],
          isError: true
        };
      }

      // Send request to Figma
      const result = await sendToFigma("set_node_visibility", { nodeIds, visible });

      // Format response
      const action = visible ? "shown" : "hidden";
      let responseText = `${result.updated.length} node${result.updated.length > 1 ? 's' : ''} ${action} successfully!\n\n`;

      result.updated.forEach((node: any, index: number) => {
        responseText += `${index + 1}. **${node.name}** (${node.type}) - ID: ${node.id}\n`;
      });

      if (result.notFound && result.notFound.length > 0) {
        responseText += `\n⚠️  ${result.notFound.length} node${result.notFound.length > 1 ? 's' : ''} not found:\n`;
        result.notFound.forEach((id: string) => {
          responseText += `   - ${id}\n`;
        });
      }

      return {
        content: [
          {
            type: "text",
            text: responseText.trim()
          }
        ]
      };
    }

    if (name === "set_node_lock") {
      // Lock/unlock nodes
      const nodeIds = (args as any)?.nodeIds;
      const locked = (args as any)?.locked;

      if (!nodeIds || !Array.isArray(nodeIds) || nodeIds.length === 0 || locked === undefined) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Both nodeIds (array) and locked (boolean) parameters are required."
            }
          ],
          isError: true
        };
      }

      // Send request to Figma
      const result = await sendToFigma("set_node_lock", { nodeIds, locked });

      // Format response
      const action = locked ? "locked" : "unlocked";
      let responseText = `${result.updated.length} node${result.updated.length > 1 ? 's' : ''} ${action} successfully!\n\n`;

      result.updated.forEach((node: any, index: number) => {
        responseText += `${index + 1}. **${node.name}** (${node.type}) - ID: ${node.id}\n`;
      });

      if (result.notFound && result.notFound.length > 0) {
        responseText += `\n⚠️  ${result.notFound.length} node${result.notFound.length > 1 ? 's' : ''} not found:\n`;
        result.notFound.forEach((id: string) => {
          responseText += `   - ${id}\n`;
        });
      }

      return {
        content: [
          {
            type: "text",
            text: responseText.trim()
          }
        ]
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    // Return user-friendly error message
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error executing tool "${name}": ${errorMessage}`
        }
      ],
      isError: true
    };
  }
});

// Start WebSocket server for Figma plugin
async function startWebSocketServer() {
  const app = express();
  app.use(cors());

  // Health check endpoint
  app.get("/health", (req, res) => {
    res.json({ status: "ok", server: "figma-mcp-server" });
  });

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    console.error("Figma plugin connected via WebSocket");

    // Store connection reference
    serverState.figmaConnection = ws;
    serverState.isConnected = true;

    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString()) as WebSocketMessage;
        console.error(`Received from Figma: ${data.type}`);

        // Route message based on type
        if (data.type === "tool_response") {
          // Handle tool response from Figma
          handleFigmaResponse(data as FigmaToolResponse);
        } else if (data.type === "event") {
          // Handle Figma events (future use)
          console.error(`Figma event: ${(data as FigmaEvent).event}`, (data as FigmaEvent).data);
        } else {
          console.error("Unknown message type from Figma:", data);
        }
      } catch (error) {
        console.error("Error parsing message from Figma:", error);
      }
    });

    ws.on("close", () => {
      console.error("Figma plugin disconnected");
      serverState.figmaConnection = null;
      serverState.isConnected = false;

      // Reject all pending requests
      for (const [id, pending] of serverState.pendingRequests.entries()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Figma plugin disconnected"));
        serverState.pendingRequests.delete(id);
      }
    });

    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });

    // Send welcome message
    ws.send(JSON.stringify({ type: "welcome", message: "Connected to MCP server" }));
  });

  httpServer.listen(WS_PORT, () => {
    console.error(`WebSocket server for Figma plugin running on ws://localhost:${WS_PORT}`);
  });
}

// Start the server
async function main() {
  // Check mode: use --websocket flag for WebSocket-only mode (for testing)
  const useWebSocketOnly = process.argv.includes('--websocket');

  if (useWebSocketOnly) {
    // Standalone WebSocket mode for testing/development
    console.error("Starting Figma MCP server in WebSocket-only mode...");
    await startWebSocketServer();
    console.error("Server ready for Figma plugin connections");
  } else {
    // Dual mode: Stdio for Claude Desktop + WebSocket for Figma plugin
    // This allows Claude Desktop to communicate with Figma through the same process
    console.error("Starting Figma MCP server in dual mode (stdio + WebSocket)...");

    // Start WebSocket server for Figma plugin connection
    await startWebSocketServer();
    console.error("WebSocket server started for Figma plugin");

    // Connect to Claude Desktop via stdio
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Stdio transport connected for Claude Desktop");
    console.error("Server ready: Claude Desktop ←→ MCP Server ←→ Figma Plugin");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
