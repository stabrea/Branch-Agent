# api-client

## Usage

```js
import { createClient } from "./src/client.js";

const client = createClient({ url: "https://example.com", timeout: 5, verbose: true });
```

### Options

| option | meaning | default |
|---|---|---|
| `url` | where the API lives | required |
| `timeout` | seconds before giving up | 5 |
| `verbose` | log every request | false |
