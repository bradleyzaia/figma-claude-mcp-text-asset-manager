// This file runs in the Figma plugin sandbox
// It handles communication between the UI and Figma's API

// Show the plugin UI
figma.showUI(__html__, { width: 300, height: 200 });

// ============================================================================
// Node Serialization Utilities
// ============================================================================

/**
 * Serialize a Figma node to a plain object
 * @param {SceneNode} node - Figma node to serialize
 * @param {boolean} includeChildren - Whether to include child nodes
 * @returns {Object} Serialized node data
 */
function serializeNode(node, includeChildren = false) {
  const baseData = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    locked: node.locked,
  };

  // Add position and size for nodes that have them
  if ('x' in node) baseData.x = node.x;
  if ('y' in node) baseData.y = node.y;
  if ('width' in node) baseData.width = node.width;
  if ('height' in node) baseData.height = node.height;

  // Add text content for text nodes
  if (node.type === 'TEXT') {
    baseData.characters = node.characters;
    baseData.fontSize = node.fontSize;
    baseData.fontName = node.fontName;
  }

  // Add children if requested and node has them
  if (includeChildren && 'children' in node) {
    baseData.children = node.children.map(child => serializeNode(child, false));
  }

  return baseData;
}

// ============================================================================
// Tool Handlers
// ============================================================================

/**
 * Registry of tool handlers
 * Each handler receives args and returns result data or throws error
 */
const toolHandlers = {
  /**
   * Test tool - pings back with timestamp
   */
  ping: async (args) => {
    return {
      message: args.message || "Pong from Figma!",
      timestamp: new Date().toISOString(),
      figmaVersion: figma.version,
    };
  },

  /**
   * Phase 1: Get currently selected nodes
   */
  get_selection: async (args) => {
    const includeChildren = args.includeChildren || false;
    const selection = figma.currentPage.selection;

    // Serialize selected nodes
    const selectionData = selection.map(node => serializeNode(node, includeChildren));

    return {
      selection: selectionData,
      count: selection.length,
      pageName: figma.currentPage.name,
    };
  },

  /**
   * Phase 1: Select specific nodes by ID
   */
  set_selection: async (args) => {
    const nodeIds = args.nodeIds || [];

    if (!Array.isArray(nodeIds)) {
      throw new Error("nodeIds must be an array");
    }

    const nodesToSelect = [];
    const notFound = [];

    // Find each node by ID
    for (const id of nodeIds) {
      const node = figma.getNodeById(id);
      if (node && 'id' in node) {
        nodesToSelect.push(node);
      } else {
        notFound.push(id);
      }
    }

    // Update selection
    figma.currentPage.selection = nodesToSelect;

    // Zoom to selection if any nodes were found
    if (nodesToSelect.length > 0) {
      figma.viewport.scrollAndZoomIntoView(nodesToSelect);
    }

    // Return info about selected nodes
    return {
      selectedCount: nodesToSelect.length,
      selected: nodesToSelect.map(node => serializeNode(node, false)),
      notFound: notFound,
    };
  },

  /**
   * Phase 2: Scan a frame and get its children
   */
  scan_frame: async (args) => {
    const frameId = args.frameId;
    const depth = Math.min(args.depth || 1, 5);
    const filter = args.filter;

    // Get frame - either by ID or from selection
    let frame;
    if (frameId) {
      frame = figma.getNodeById(frameId);
      if (!frame) {
        throw new Error(`Frame with ID ${frameId} not found`);
      }
    } else {
      // Use first selected node
      const selection = figma.currentPage.selection;
      if (selection.length === 0) {
        throw new Error('No frame specified and nothing selected');
      }
      frame = selection[0];
    }

    // Check if node has children
    if (!('children' in frame)) {
      throw new Error(`Node "${frame.name}" (${frame.type}) cannot contain children`);
    }

    // Recursively scan children
    function scanChildren(node, currentDepth, currentLevel) {
      const results = [];

      if (currentDepth > depth) {
        return results;
      }

      if ('children' in node) {
        for (const child of node.children) {
          // Apply filter if specified
          if (filter && child.type !== filter) {
            // Still scan children if we haven't reached depth limit
            if (currentDepth < depth) {
              results.push(...scanChildren(child, currentDepth + 1, currentLevel));
            }
            continue;
          }

          const childData = serializeNode(child, false);
          childData.level = currentLevel;
          childData.childCount = 'children' in child ? child.children.length : 0;
          results.push(childData);

          // Recursively scan children
          if (currentDepth < depth && 'children' in child) {
            results.push(...scanChildren(child, currentDepth + 1, currentLevel + 1));
          }
        }
      }

      return results;
    }

    const children = scanChildren(frame, 1, 0);

    return {
      frameId: frame.id,
      frameName: frame.name,
      frameType: frame.type,
      children: children,
    };
  },

  /**
   * Phase 2: Find nodes matching criteria
   */
  find_nodes: async (args) => {
    const searchTerm = args.searchTerm;
    const nodeType = args.nodeType;
    const visibleOnly = args.visibleOnly || false;
    const searchScope = args.searchScope || 'page';

    // Determine search root
    let searchRoot;
    if (searchScope === 'selection') {
      const selection = figma.currentPage.selection;
      if (selection.length === 0) {
        throw new Error('Search scope is "selection" but nothing is selected');
      }
      searchRoot = selection[0];
    } else if (searchScope === 'page') {
      searchRoot = figma.currentPage;
    } else {
      // Assume it's a node ID
      searchRoot = figma.getNodeById(searchScope);
      if (!searchRoot) {
        throw new Error(`Node with ID ${searchScope} not found`);
      }
    }

    // Find matching nodes
    const results = searchRoot.findAll(node => {
      // Check node type filter
      if (nodeType && node.type !== nodeType) {
        return false;
      }

      // Check visibility filter
      if (visibleOnly && !node.visible) {
        return false;
      }

      // Check search term
      if (searchTerm) {
        const searchLower = searchTerm.toLowerCase();
        const nameLower = node.name.toLowerCase();
        if (!nameLower.includes(searchLower)) {
          return false;
        }
      }

      return true;
    });

    // Serialize results with parent info
    const serializedResults = results.map(node => {
      const data = serializeNode(node, false);
      if (node.parent && node.parent.type !== 'PAGE') {
        data.parent = {
          id: node.parent.id,
          name: node.parent.name,
          type: node.parent.type,
        };
      }
      return data;
    });

    return {
      results: serializedResults,
      count: serializedResults.length,
    };
  },

  /**
   * Phase 2: Get detailed properties of nodes
   */
  get_node_properties: async (args) => {
    const nodeIds = args.nodeIds || [];

    if (!Array.isArray(nodeIds)) {
      throw new Error("nodeIds must be an array");
    }

    const nodes = [];
    const notFound = [];

    for (const id of nodeIds) {
      const node = figma.getNodeById(id);
      if (!node) {
        notFound.push(id);
        continue;
      }

      // Get comprehensive node data
      const nodeData = {
        id: node.id,
        name: node.name,
        type: node.type,
        visible: node.visible,
        locked: node.locked,
      };

      // Position and dimensions
      if ('x' in node) nodeData.x = node.x;
      if ('y' in node) nodeData.y = node.y;
      if ('width' in node) nodeData.width = node.width;
      if ('height' in node) nodeData.height = node.height;
      if ('rotation' in node) nodeData.rotation = node.rotation;

      // Opacity
      if ('opacity' in node) nodeData.opacity = node.opacity;

      // Fills, strokes, effects
      if ('fills' in node) nodeData.fills = node.fills;
      if ('strokes' in node) nodeData.strokes = node.strokes;
      if ('effects' in node) nodeData.effects = node.effects;

      // Parent info
      if (node.parent && node.parent.type !== 'PAGE') {
        nodeData.parent = {
          id: node.parent.id,
          name: node.parent.name,
          type: node.parent.type,
        };
      }

      // Children count
      if ('children' in node) {
        nodeData.childCount = node.children.length;
      }

      // Text-specific properties
      if (node.type === 'TEXT') {
        nodeData.characters = node.characters;
        nodeData.fontSize = node.fontSize;
        nodeData.fontName = node.fontName;
        nodeData.textAlignHorizontal = node.textAlignHorizontal;
        nodeData.textAlignVertical = node.textAlignVertical;
      }

      nodes.push(nodeData);
    }

    return {
      nodes: nodes,
      notFound: notFound,
    };
  },

  /**
   * Phase 3: Get text content from text nodes
   */
  get_text_content: async (args) => {
    const nodeIds = args.nodeIds;
    const textNodes = [];

    if (nodeIds && Array.isArray(nodeIds)) {
      // Get specific nodes by ID
      for (const id of nodeIds) {
        const node = figma.getNodeById(id);
        if (node && node.type === 'TEXT') {
          textNodes.push(node);
        }
      }
    } else {
      // Get from selection
      const selection = figma.currentPage.selection;
      for (const node of selection) {
        if (node.type === 'TEXT') {
          textNodes.push(node);
        }
      }
    }

    // Serialize text node data
    const serializedTextNodes = textNodes.map(node => ({
      id: node.id,
      name: node.name,
      characters: node.characters,
      fontSize: node.fontSize,
      fontName: node.fontName,
      textAlignHorizontal: node.textAlignHorizontal,
      textAlignVertical: node.textAlignVertical,
    }));

    return {
      textNodes: serializedTextNodes,
    };
  },

  /**
   * Phase 3: Update text content in a text node
   */
  set_text_content: async (args) => {
    const nodeId = args.nodeId;
    const newText = args.text;

    if (!nodeId || !newText) {
      throw new Error('nodeId and text are required');
    }

    const node = figma.getNodeById(nodeId);
    if (!node) {
      throw new Error(`Node with ID ${nodeId} not found`);
    }

    if (node.type !== 'TEXT') {
      throw new Error(`Node ${nodeId} is not a text node (type: ${node.type})`);
    }

    // Store previous text
    const previousText = node.characters;

    // Load font before editing
    await figma.loadFontAsync(node.fontName);

    // Update text
    node.characters = newText;

    return {
      nodeId: node.id,
      nodeName: node.name,
      previousText: previousText,
      newText: newText,
      fontName: node.fontName,
    };
  },

  /**
   * Phase 3: Create a new text node
   */
  create_text_node: async (args) => {
    const text = args.text;
    const x = args.x !== undefined ? args.x : 0;
    const y = args.y !== undefined ? args.y : 0;
    const fontSize = args.fontSize || 16;
    const fontFamily = args.fontFamily || 'Inter';
    const fontStyle = args.fontStyle || 'Regular';
    const parentId = args.parentId;

    // Create text node
    const textNode = figma.createText();

    // Load font
    const fontName = { family: fontFamily, style: fontStyle };
    try {
      await figma.loadFontAsync(fontName);
    } catch (error) {
      // If font fails to load, try Inter Regular as fallback
      const fallbackFont = { family: 'Inter', style: 'Regular' };
      await figma.loadFontAsync(fallbackFont);
      textNode.fontName = fallbackFont;
    }

    // Set text and properties
    textNode.fontName = fontName;
    textNode.fontSize = fontSize;
    textNode.characters = text;
    textNode.x = x;
    textNode.y = y;

    // Add to parent if specified
    let parentName = null;
    if (parentId) {
      const parent = figma.getNodeById(parentId);
      if (parent && 'appendChild' in parent) {
        parent.appendChild(textNode);
        parentName = parent.name;
      } else {
        throw new Error(`Parent node ${parentId} not found or cannot contain children`);
      }
    } else {
      // Add to current page
      figma.currentPage.appendChild(textNode);
    }

    // Select the new node and zoom to it
    figma.currentPage.selection = [textNode];
    figma.viewport.scrollAndZoomIntoView([textNode]);

    return {
      nodeId: textNode.id,
      nodeName: textNode.name,
      text: textNode.characters,
      x: textNode.x,
      y: textNode.y,
      fontSize: textNode.fontSize,
      fontName: textNode.fontName,
      parentName: parentName,
    };
  },

  /**
   * Phase 4: Rename one or more nodes
   */
  rename_node: async (args) => {
    const nodeIds = args.nodeIds || [];
    const newName = args.newName;

    if (!Array.isArray(nodeIds)) {
      throw new Error('nodeIds must be an array');
    }

    const renamed = [];
    const notFound = [];

    for (let i = 0; i < nodeIds.length; i++) {
      const id = nodeIds[i];
      const node = figma.getNodeById(id);

      if (!node) {
        notFound.push(id);
        continue;
      }

      const oldName = node.name;

      // Support {index} placeholder for bulk renaming
      const processedName = newName.replace(/\{index\}/g, (i + 1).toString());
      node.name = processedName;

      renamed.push({
        id: node.id,
        oldName: oldName,
        newName: node.name,
        type: node.type,
      });
    }

    return {
      renamed: renamed,
      notFound: notFound,
    };
  },

  /**
   * Phase 4: Set visibility of nodes
   */
  set_node_visibility: async (args) => {
    const nodeIds = args.nodeIds || [];
    const visible = args.visible;

    if (!Array.isArray(nodeIds)) {
      throw new Error('nodeIds must be an array');
    }

    if (typeof visible !== 'boolean') {
      throw new Error('visible must be a boolean');
    }

    const updated = [];
    const notFound = [];

    for (const id of nodeIds) {
      const node = figma.getNodeById(id);

      if (!node) {
        notFound.push(id);
        continue;
      }

      node.visible = visible;

      updated.push({
        id: node.id,
        name: node.name,
        type: node.type,
      });
    }

    return {
      updated: updated,
      notFound: notFound,
    };
  },

  /**
   * Phase 4: Lock or unlock nodes
   */
  set_node_lock: async (args) => {
    const nodeIds = args.nodeIds || [];
    const locked = args.locked;

    if (!Array.isArray(nodeIds)) {
      throw new Error('nodeIds must be an array');
    }

    if (typeof locked !== 'boolean') {
      throw new Error('locked must be a boolean');
    }

    const updated = [];
    const notFound = [];

    for (const id of nodeIds) {
      const node = figma.getNodeById(id);

      if (!node) {
        notFound.push(id);
        continue;
      }

      node.locked = locked;

      updated.push({
        id: node.id,
        name: node.name,
        type: node.type,
      });
    }

    return {
      updated: updated,
      notFound: notFound,
    };
  },

  /**
   * New: Set stroke properties (color, weight, alignment)
   */
  set_node_stroke: async (args) => {
    const nodeIds = args.nodeIds || [];
    const color = args.color;
    const weight = args.weight;
    const align = args.align;

    if (!Array.isArray(nodeIds)) {
      throw new Error('nodeIds must be an array');
    }

    const updated = [];
    const notFound = [];

    for (const id of nodeIds) {
      const node = figma.getNodeById(id);

      if (!node) {
        notFound.push(id);
        continue;
      }

      // Check if node supports strokes
      if (!('strokes' in node)) {
        throw new Error(`Node ${id} (${node.type}) does not support strokes`);
      }

      // Update stroke color
      if (color) {
        const rgb = {
          r: color.r !== undefined ? color.r : 0,
          g: color.g !== undefined ? color.g : 0,
          b: color.b !== undefined ? color.b : 0,
        };

        const opacity = color.a !== undefined ? color.a : 1;

        // Create solid color paint
        const strokePaint = {
          type: 'SOLID',
          color: rgb,
          opacity: opacity,
        };

        node.strokes = [strokePaint];
      }

      // Update stroke weight
      if (weight !== undefined) {
        if ('strokeWeight' in node) {
          node.strokeWeight = weight;
        }
      }

      // Update stroke alignment
      if (align) {
        if ('strokeAlign' in node) {
          node.strokeAlign = align;
        }
      }

      updated.push({
        id: node.id,
        name: node.name,
        type: node.type,
      });
    }

    return {
      updated: updated,
      notFound: notFound,
    };
  },

  // Phase 5 will be added next
};

/**
 * Execute a tool request
 * @param {string} toolName - Name of the tool to execute
 * @param {Object} args - Tool arguments
 * @returns {Promise<Object>} Tool result data
 * @throws {Error} If tool not found or execution fails
 */
async function executeTool(toolName, args) {
  const handler = toolHandlers[toolName];

  if (!handler) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  return await handler(args);
}

// ============================================================================
// Message Handlers
// ============================================================================

// Listen for messages from the UI
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'check-connection') {
    // Acknowledge ready state
    figma.ui.postMessage({
      type: 'connection-status',
      status: 'ready'
    });
  }

  if (msg.type === 'connect-to-mcp') {
    // Pass connection request to UI (WebSocket connection happens in UI)
    figma.ui.postMessage({
      type: 'start-connection'
    });
  }

  if (msg.type === 'disconnect-from-mcp') {
    // Pass disconnection request to UI
    figma.ui.postMessage({
      type: 'start-disconnection'
    });
  }

  // Handle tool execution requests from MCP server (via UI)
  if (msg.type === 'tool_request') {
    const { id, tool, args } = msg;

    try {
      // Execute the tool
      const data = await executeTool(tool, args);

      // Send success response back to UI (which forwards to MCP server)
      figma.ui.postMessage({
        type: 'tool_response',
        id: id,
        success: true,
        data: data
      });
    } catch (error) {
      // Send error response back to UI
      figma.ui.postMessage({
        type: 'tool_response',
        id: id,
        success: false,
        error: error.message || String(error)
      });
    }
  }
};
