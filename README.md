# @enemyrr/mcp-mysql-server


A Model Context Protocol server that provides MySQL database operations. This server enables AI models to interact with MySQL databases through a standardized interface, allowing them to run queries, manage schema, and perform various database operations.


## Installation & Setup for Cursor IDE



### Installing Manually
1. Clone and build the project:
```bash
git clone https://github.com/enemyrr/mcp-mysql-server.git
cd mcp-mysql-server
npm install
npm run build
```

2. Add the server in Cursor IDE settings:
   - Open Command Palette (Cmd/Ctrl + Shift + P)
   - Search for "MCP: Add Server"
   - Fill in the fields:
     - Name: `mysql`
     - Type: `command`
     - Command: `node /absolute/path/to/mcp-mysql-server/build/index.js`

> **Note**: Replace `/absolute/path/to/` with the actual path where you cloned and built the project.

## Database Configuration


```env
DB_HOST=localhost
DB_USER=your_user
DB_PASSWORD=your_password
DB_DATABASE=your_database
DB_SSL=true  # Optional, enables SSL
DB_CONNECTION_TIMEOUT=10000  # Optional, defaults to 10000ms
```



## Available Tools

### 1. query
Execute SELECT queries with optional prepared statement parameters.

```typescript
use_mcp_tool({
  server_name: "mysql",
  tool_name: "query",
  arguments: {
    sql: "SELECT * FROM users WHERE id = ?",
    params: [1]  // Optional
  }
});
```

### 2. execute
Execute INSERT, UPDATE, or DELETE queries with optional prepared statement parameters.

```typescript
use_mcp_tool({
  server_name: "mysql",
  tool_name: "execute",
  arguments: {
    sql: "INSERT INTO users (name, email) VALUES (?, ?)",
    params: ["John Doe", "john@example.com"]  // Optional
  }
});
```

### 3. list_tables
List all tables in the connected database.

```typescript
use_mcp_tool({
  server_name: "mysql",
  tool_name: "list_tables"
});
```

### 4. describe_table
Get the structure of a specific table.

```typescript
use_mcp_tool({
  server_name: "mysql",
  tool_name: "describe_table",
  arguments: {
    table: "users"
  }
});
```

### 5. create_table
Create a new table with specified fields and optional indexes.

```typescript
use_mcp_tool({
  server_name: "mysql",
  tool_name: "create_table",
  arguments: {
    table: "users",
    fields: [
      {
        name: "id",
        type: "int",
        autoIncrement: true,
        primary: true
      },
      {
        name: "email",
        type: "varchar",
        length: 255,
        nullable: false
      }
    ],
    indexes: [  // Optional
      {
        name: "email_idx",
        columns: ["email"],
        unique: true
      }
    ]
  }
});
```

### 6. add_column
Add a new column to an existing table.

```typescript
use_mcp_tool({
  server_name: "mysql",
  tool_name: "add_column",
  arguments: {
    table: "users",
    field: {
      name: "phone",
      type: "varchar",
      length: 20,
      nullable: true,
      default: null  // Optional
    }
  }
});
```

## Features

- **Multiple Connection Methods**: Connect via URL, environment variables, or direct parameters
- **Connection Pooling**: Efficiently manages database connections
- **Prepared Statements**: Protection against SQL injection attacks
- **Comprehensive Schema Tools**: Create tables, add columns, inspect schema
- **Input Validation**: Validates SQL statements and parameters before execution
- **SSL Support**: Secure database connections with SSL/TLS
- **Error Handling**: Detailed error reporting and validation
- **Automatic Connection Management**: Connections are established on-demand and cleaned up properly

## Security

- **SQL Injection Protection**: Uses prepared statements for all queries
- **Secure Password Handling**: Supports environment variables to keep credentials out of code
- **Input Validation**: Validates query types and parameters
- **SSL Support**: Secure connections to database servers
- **Connection Cleanup**: Automatically closes connections to prevent leaks

## Error Handling

The server provides detailed error messages for:
- Connection failures (invalid credentials, unreachable server)
- Malformed connection strings
- Invalid queries or query parameters
- Missing configuration values
- Database constraint violations
- Schema validation errors

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request to https://github.com/enemyrr/mcp-mysql-server

## License

MIT
