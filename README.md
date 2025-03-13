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
Execute SELECT amy mysl queries.

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

### 2. list_tables
List all tables in the connected database.

```typescript
use_mcp_tool({
  server_name: "mysql",
  tool_name: "list_tables"
});
```

### 3. describe_table
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

## License

MIT
