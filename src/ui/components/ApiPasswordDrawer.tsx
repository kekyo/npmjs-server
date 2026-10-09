// npmjs-server - NPM package registry server on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import DeleteIcon from '@mui/icons-material/Delete';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import { apiFetch } from '../utils/apiClient';

interface ApiPasswordDrawerProps {
  open: boolean;
  onClose: () => void;
}

interface NpmToken {
  key: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface NpmTokenListResponse {
  npmTokens: NpmToken[];
}

const ApiPasswordDrawer = ({ open, onClose }: ApiPasswordDrawerProps) => {
  const [tokens, setTokens] = useState<NpmToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTokens = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch('api/ui/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'list' }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as NpmTokenListResponse;
      setTokens(data.npmTokens);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tokens');
    } finally {
      setLoading(false);
    }
  };

  const revokeToken = async (key: string) => {
    setError(null);
    try {
      const response = await apiFetch('api/ui/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'delete', key }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      await loadTokens();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke token');
    }
  };

  useEffect(() => {
    if (open) {
      loadTokens();
    }
  }, [open]);

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      variant="temporary"
      sx={{
        '& .MuiDrawer-paper': {
          width: 440,
          boxSizing: 'border-box',
        },
      }}
    >
      <Box sx={{ p: 3, height: '100%' }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            mb: 3,
          }}
        >
          <Typography
            variant="h6"
            component="h2"
            sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
          >
            <VpnKeyIcon />
            npm tokens
          </Typography>
          <IconButton onClick={onClose} edge="end">
            <CloseIcon />
          </IconButton>
        </Box>

        <Divider sx={{ mb: 3 }} />

        <Alert severity="info" sx={{ mb: 2 }}>
          Tokens are created by running npm login against this registry. Token
          values are shown only to npm during login and cannot be displayed
          again.
        </Alert>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
            <CircularProgress />
          </Box>
        ) : tokens.length === 0 ? (
          <Alert severity="warning">No npm tokens have been issued.</Alert>
        ) : (
          <List>
            {tokens.map((token) => (
              <ListItem
                key={token.key}
                secondaryAction={
                  <Button
                    color="error"
                    startIcon={<DeleteIcon />}
                    onClick={() => revokeToken(token.key)}
                  >
                    Revoke
                  </Button>
                }
              >
                <ListItemText
                  primary={token.label}
                  secondary={`key: ${token.key} / created: ${new Date(
                    token.createdAt
                  ).toLocaleString()}${
                    token.lastUsedAt
                      ? ` / last used: ${new Date(
                          token.lastUsedAt
                        ).toLocaleString()}`
                      : ''
                  }`}
                />
              </ListItem>
            ))}
          </List>
        )}
      </Box>
    </Drawer>
  );
};

export default ApiPasswordDrawer;
