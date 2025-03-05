#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import * as mysql from 'mysql2/promise';
import { config } from 'dotenv';
import { parse as parseUrl } from 'url';
import path from 'path';

// Load environment variables
config();

interface DatabaseConfig {
  host: string;
  user: string;
  password: string;
  database: string;
}

// New type definitions
interface SSLConfig {
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
}

interface ConnectionConfig extends DatabaseConfig {
  ssl?: SSLConfig;
  connectionTimeout?: number;
  connectRetry?: {
    maxAttempts: number;
    delay: number;
  };
}

interface SchemaField {
  name: string;
  type: string;
  length?: number;
  nullable?: boolean;
  default?: string | number | null;
  autoIncrement?: boolean;
  primary?: boolean;
}

interface IndexDefinition {
  name: string;
  columns: string[];
  unique?: boolean;
}

// Type guard for error objects
function isErrorWithMessage(error: unknown): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

// Helper to get error message
function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  return String(error);
}

class MySQLServer {
  private server: Server;
  private connection: mysql.Connection | null = null;
  private config: DatabaseConfig | null = null;
  private currentWorkspace: string | null = null;

  constructor() {
    this.server = new Server(
      {
        name: 'mysql-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  private async cleanup() {
    if (this.connection) {
      await this.connection.end();
    }
    await this.server.close();
  }

  private async ensureConnection() {
    if (!this.config) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Database configuration not set. Use connect_db tool first.'
      );
    }

    if (!this.connection) {
      try {
        this.connection = await mysql.createConnection(this.config);
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to connect to database: ${getErrorMessage(error)}`
        );
      }
    }
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'connect_db',
          description: 'Connect to MySQL database using URL or config',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'Database URL (mysql://user:pass@host:port/db)',
                optional: true
              },
              workspace: {
                type: 'string',
                description: 'Project workspace path',
                optional: true
              },
              // Keep existing connection params as fallback
              host: { type: 'string', optional: true },
              user: { type: 'string', optional: true },
              password: { type: 'string', optional: true },
              database: { type: 'string', optional: true }
            },
            // No required fields - will try different connection methods
          },
        },
        {
          name: 'query',
          description: 'Execute a SELECT query',
          inputSchema: {
            type: 'object',
            properties: {
              sql: {
                type: 'string',
                description: 'SQL SELECT query',
              },
              params: {
                type: 'array',
                items: {
                  type: ['string', 'number', 'boolean', 'null'],
                },
                description: 'Query parameters (optional)',
              },
            },
            required: ['sql'],
          },
        },
        {
          name: 'execute',
          description: 'Execute an INSERT, UPDATE, or DELETE query',
          inputSchema: {
            type: 'object',
            properties: {
              sql: {
                type: 'string',
                description: 'SQL query (INSERT, UPDATE, DELETE)',
              },
              params: {
                type: 'array',
                items: {
                  type: ['string', 'number', 'boolean', 'null'],
                },
                description: 'Query parameters (optional)',
              },
            },
            required: ['sql'],
          },
        },
        {
          name: 'list_tables',
          description: 'List all tables in the database',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'describe_table',
          description: 'Get table structure',
          inputSchema: {
            type: 'object',
            properties: {
              table: {
                type: 'string',
                description: 'Table name',
              },
            },
            required: ['table'],
          },
        },
        {
          name: 'create_table',
          description: 'Create a new table in the database',
          inputSchema: {
            type: 'object',
            properties: {
              table: {
                type: 'string',
                description: 'Table name',
              },
              fields: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string' },
                    length: { type: 'number', optional: true },
                    nullable: { type: 'boolean', optional: true },
                    default: {
                      type: ['string', 'number', 'null'],
                      optional: true
                    },
                    autoIncrement: { type: 'boolean', optional: true },
                    primary: { type: 'boolean', optional: true }
                  },
                  required: ['name', 'type']
                }
              },
              indexes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    columns: {
                      type: 'array',
                      items: { type: 'string' }
                    },
                    unique: { type: 'boolean', optional: true }
                  },
                  required: ['name', 'columns']
                },
                optional: true
              }
            },
            required: ['table', 'fields']
          }
        },
        {
          name: 'add_column',
          description: 'Add a new column to existing table',
          inputSchema: {
            type: 'object',
            properties: {
              table: { type: 'string' },
              field: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  type: { type: 'string' },
                  length: { type: 'number', optional: true },
                  nullable: { type: 'boolean', optional: true },
                  default: {
                    type: ['string', 'number', 'null'],
                    optional: true
                  }
                },
                required: ['name', 'type']
              }
            },
            required: ['table', 'field']
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'connect_db':
          return await this.handleConnectDb(request.params.arguments);
        case 'query':
          return await this.handleQuery(request.params.arguments);
        case 'execute':
          return await this.handleExecute(request.params.arguments);
        case 'list_tables':
          return await this.handleListTables();
        case 'describe_table':
          return await this.handleDescribeTable(request.params.arguments);
        case 'create_table':
          return await this.handleCreateTable(request.params.arguments);
        case 'add_column':
          return await this.handleAddColumn(request.params.arguments);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  private async loadWorkspaceConfig(workspace: string): Promise<ConnectionConfig | null> {
    try {
      // Try loading .env from the workspace
      const envPath = path.join(workspace, '.env');
      const workspaceEnv = require('dotenv').config({ path: envPath });

      if (workspaceEnv.error) {
        return null;
      }

      const { DATABASE_URL, DB_HOST, DB_USER, DB_PASSWORD, DB_DATABASE } = workspaceEnv.parsed;

      if (DATABASE_URL) {
        return this.parseConnectionUrl(DATABASE_URL);
      }

      if (DB_HOST && DB_USER && DB_PASSWORD && DB_DATABASE) {
        return {
          host: DB_HOST,
          user: DB_USER,
          password: DB_PASSWORD,
          database: DB_DATABASE
        };
      }

      return null;
    } catch (error) {
      console.error('Error loading workspace config:', error);
      return null;
    }
  }

  private async handleConnectDb(args: any) {
    let config: ConnectionConfig | null = null;

    // Priority 1: Direct URL
    if (args.url) {
      config = this.parseConnectionUrl(args.url);
    }
    // Priority 2: Workspace config
    else if (args.workspace) {
      this.currentWorkspace = args.workspace;
      config = await this.loadWorkspaceConfig(args.workspace);
    }
    // Priority 3: Individual connection params
    else if (args.host && args.user && args.password && args.database) {
      config = {
        host: args.host,
        user: args.user,
        password: args.password,
        database: args.database
      };
    }

    if (!config) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'No valid database configuration provided. Please provide either a URL, workspace path, or connection parameters.'
      );
    }

    // Close existing connection if any
    if (this.connection) {
      await this.connection.end();
      this.connection = null;
    }

    this.config = config;

    try {
      await this.ensureConnection();
      return {
        content: [
          {
            type: 'text',
            text: `Successfully connected to database ${config.database} at ${config.host}`
          }
        ]
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to connect to database: ${getErrorMessage(error)}`
      );
    }
  }

  private parseConnectionUrl(url: string): ConnectionConfig {
    const parsed = parseUrl(url);
    if (!parsed.host || !parsed.auth) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Invalid connection URL'
      );
    }

    const [user, password] = parsed.auth.split(':');
    const database = parsed.pathname?.slice(1);

    if (!database) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Database name must be specified in URL'
      );
    }

    return {
      host: parsed.hostname!,
      user,
      password: password || '',
      database,
      ssl: parsed.protocol === 'mysqls:' ? { rejectUnauthorized: true } : undefined
    };
  }

  private async handleQuery(args: any) {
    await this.ensureConnection();

    if (!args.sql) {
      throw new McpError(ErrorCode.InvalidParams, 'SQL query is required');
    }

    if (!args.sql.trim().toUpperCase().startsWith('SELECT')) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Only SELECT queries are allowed with query tool'
      );
    }

    try {
      const [rows] = await this.connection!.query(args.sql, args.params || []);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(rows, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Query execution failed: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleExecute(args: any) {
    await this.ensureConnection();

    if (!args.sql) {
      throw new McpError(ErrorCode.InvalidParams, 'SQL query is required');
    }

    const sql = args.sql.trim().toUpperCase();
    if (sql.startsWith('SELECT')) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Use query tool for SELECT statements'
      );
    }

    try {
      const [result] = await this.connection!.query(args.sql, args.params || []);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Query execution failed: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleListTables() {
    await this.ensureConnection();

    try {
      const [rows] = await this.connection!.query('SHOW TABLES');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(rows, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list tables: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleDescribeTable(args: any) {
    await this.ensureConnection();

    if (!args.table) {
      throw new McpError(ErrorCode.InvalidParams, 'Table name is required');
    }

    try {
      const [rows] = await this.connection!.query(
        `SELECT 
          COLUMN_NAME as Field,
          COLUMN_TYPE as Type,
          IS_NULLABLE as \`Null\`,
          COLUMN_KEY as \`Key\`,
          COLUMN_DEFAULT as \`Default\`,
          EXTRA as Extra,
          COLUMN_COMMENT as Comment
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
        [this.config!.database, args.table]
      );

      const formattedRows = (rows as any[]).map(row => ({
        ...row,
        Null: row.Null === 'YES' ? 'YES' : 'NO'
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(formattedRows, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to describe table: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleCreateTable(args: any) {
    await this.ensureConnection();

    const fields = args.fields.map((field: SchemaField) => {
      let def = `\`${field.name}\` ${field.type.toUpperCase()}`;
      if (field.length) def += `(${field.length})`;
      if (field.nullable === false) def += ' NOT NULL';
      if (field.default !== undefined) {
        def += ` DEFAULT ${field.default === null ? 'NULL' : `'${field.default}'`}`;
      }
      if (field.autoIncrement) def += ' AUTO_INCREMENT';
      if (field.primary) def += ' PRIMARY KEY';
      return def;
    });

    const indexes = args.indexes?.map((idx: IndexDefinition) => {
      const type = idx.unique ? 'UNIQUE INDEX' : 'INDEX';
      return `${type} \`${idx.name}\` (\`${idx.columns.join('`, `')}\`)`;
    }) || [];

    const sql = `CREATE TABLE \`${args.table}\` (
      ${[...fields, ...indexes].join(',\n      ')}
    )`;

    try {
      await this.connection!.query(sql);
      return {
        content: [
          {
            type: 'text',
            text: `Table ${args.table} created successfully`
          }
        ]
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to create table: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleAddColumn(args: any) {
    await this.ensureConnection();

    if (!args.table || !args.field) {
      throw new McpError(ErrorCode.InvalidParams, 'Table name and field are required');
    }

    let sql = `ALTER TABLE \`${args.table}\` ADD COLUMN \`${args.field.name}\` ${args.field.type.toUpperCase()}`;
    if (args.field.length) sql += `(${args.field.length})`;
    if (args.field.nullable === false) sql += ' NOT NULL';
    if (args.field.default !== undefined) {
      sql += ` DEFAULT ${args.field.default === null ? 'NULL' : `'${args.field.default}'`}`;
    }

    try {
      await this.connection!.query(sql);
      return {
        content: [
          {
            type: 'text',
            text: `Column ${args.field.name} added to table ${args.table}`
          }
        ]
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to add column: ${getErrorMessage(error)}`
      );
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('MySQL MCP server running on stdio');
  }
}

const server = new MySQLServer();
server.run().catch(console.error);
