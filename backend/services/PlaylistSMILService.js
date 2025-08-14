const SSHManager = require('../config/SSHManager');
const WowzaConfigManager = require('../config/WowzaConfigManager');
const db = require('../config/database');

class PlaylistSMILService {
    constructor() {
        this.smilTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<smil>
    <head>
        <meta name="title" content="Playlists de Agendamentos" />
        <meta name="copyright" content="Sistema de Streaming" />
        <meta name="author" content="{{USER_LOGIN}}" />
        <meta name="description" content="Arquivo SMIL gerado automaticamente para agendamentos" />
    </head>
    <body>
        <switch>
{{PLAYLISTS_CONTENT}}
        </switch>
    </body>
</smil>`;
    }

    // Gerar arquivo SMIL para um usuário específico
    async generateUserSMIL(userId, userLogin, serverId) {
        try {
            console.log(`📄 Gerando arquivo SMIL para usuário: ${userLogin}`);

            // Buscar playlists do usuário
            const [playlistRows] = await db.execute(
                'SELECT id, nome FROM playlists WHERE codigo_stm = ? ORDER BY id',
                [userId]
            );

            if (playlistRows.length === 0) {
                console.log(`⚠️ Usuário ${userLogin} não possui playlists`);
                return { success: false, message: 'Usuário não possui playlists' };
            }

            let playlistsContent = '';

            // Processar cada playlist
            for (const playlist of playlistRows) {
                console.log(`📋 Processando playlist: ${playlist.nome} (ID: ${playlist.id})`);

                // Buscar vídeos da playlist
                const [videoRows] = await db.execute(
                    `SELECT v.nome, v.url, v.caminho, v.duracao 
                     FROM videos v 
                     WHERE v.playlist_id = ? AND v.codigo_cliente = ?
                     ORDER BY v.id`,
                    [playlist.id, userId]
                );

                if (videoRows.length > 0) {
                    playlistsContent += `            <seq id="playlist_${playlist.id}" title="${this.escapeXML(playlist.nome)}">\n`;

                    // Adicionar cada vídeo da playlist
                    for (const video of videoRows) {
                        const videoPath = this.buildVideoPath(video, userLogin);
                        const duration = video.duracao || 0;
                        
                        playlistsContent += `                <video src="${videoPath}" dur="${duration}s" title="${this.escapeXML(video.nome)}" />\n`;
                    }

                    playlistsContent += `            </seq>\n`;
                    console.log(`✅ Playlist ${playlist.nome}: ${videoRows.length} vídeos adicionados`);
                } else {
                    console.log(`⚠️ Playlist ${playlist.nome} não possui vídeos`);
                }
            }

            // Se não há conteúdo, criar playlist padrão
            if (!playlistsContent.trim()) {
                playlistsContent = `            <seq id="playlist_default" title="Playlist Padrão">
                <video src="${userLogin}/default/demo.mp4" dur="30s" title="Vídeo de Demonstração" />
            </seq>\n`;
            }

            // Gerar conteúdo final do SMIL
            const smilContent = this.smilTemplate
                .replace('{{USER_LOGIN}}', userLogin)
                .replace('{{PLAYLISTS_CONTENT}}', playlistsContent);

            // Salvar arquivo no servidor
            const smilPath = `/home/streaming/${userLogin}/playlists_agendamentos.smil`;
            await this.saveSMILToServer(serverId, userLogin, smilContent, smilPath);

            console.log(`✅ Arquivo SMIL gerado com sucesso para ${userLogin}`);
            return { 
                success: true, 
                smil_path: smilPath,
                playlists_count: playlistRows.length,
                total_videos: playlistsContent.split('<video').length - 1
            };

        } catch (error) {
            console.error(`Erro ao gerar SMIL para usuário ${userLogin}:`, error);
            return { success: false, error: error.message };
        }
    }

    // Construir caminho do vídeo para o SMIL
    buildVideoPath(video, userLogin) {
        // Nova estrutura: usuario/pasta/arquivo.mp4
        if (video.caminho && video.caminho.includes('/home/streaming/')) {
            // Extrair caminho relativo da nova estrutura
            const relativePath = video.caminho.replace('/home/streaming/', '');
            return relativePath;
        } else if (video.url) {
            // Usar URL se disponível
            let cleanUrl = video.url;
            if (cleanUrl.startsWith('streaming/')) {
                cleanUrl = cleanUrl.replace('streaming/', '');
            }
            return cleanUrl;
        } else {
            // Fallback: construir caminho baseado no nome
            return `${userLogin}/default/${video.nome}`;
        }
    }

    // Salvar arquivo SMIL no servidor
    async saveSMILToServer(serverId, userLogin, smilContent, smilPath) {
        try {
            // Criar arquivo temporário local
            const tempFile = `/tmp/playlists_agendamentos_${userLogin}_${Date.now()}.smil`;
            const fs = require('fs').promises;
            await fs.writeFile(tempFile, smilContent, 'utf8');

            // Enviar para servidor
            await SSHManager.uploadFile(serverId, tempFile, smilPath);
            
            // Definir permissões corretas
            await SSHManager.executeCommand(serverId, `chmod 644 "${smilPath}"`);
            await SSHManager.executeCommand(serverId, `chown streaming:streaming "${smilPath}"`);

            // Limpar arquivo temporário
            await fs.unlink(tempFile);

            console.log(`📤 Arquivo SMIL enviado para: ${smilPath}`);
            return { success: true, path: smilPath };

        } catch (error) {
            console.error('Erro ao salvar SMIL no servidor:', error);
            throw error;
        }
    }

    // Atualizar SMIL quando playlist for modificada
    async updateUserSMIL(userId, userLogin, serverId) {
        try {
            console.log(`🔄 Atualizando SMIL para usuário: ${userLogin}`);
            return await this.generateUserSMIL(userId, userLogin, serverId);
        } catch (error) {
            console.error(`Erro ao atualizar SMIL para ${userLogin}:`, error);
            return { success: false, error: error.message };
        }
    }

    // Remover arquivo SMIL do usuário
    async removeUserSMIL(serverId, userLogin) {
        try {
            const smilPath = `/home/streaming/${userLogin}/playlists_agendamentos.smil`;
            await SSHManager.deleteFile(serverId, smilPath);
            console.log(`🗑️ Arquivo SMIL removido: ${smilPath}`);
            return { success: true };
        } catch (error) {
            console.error(`Erro ao remover SMIL para ${userLogin}:`, error);
            return { success: false, error: error.message };
        }
    }

    // Verificar se arquivo SMIL existe
    async checkSMILExists(serverId, userLogin) {
        try {
            const smilPath = `/home/streaming/${userLogin}/playlists_agendamentos.smil`;
            const fileInfo = await SSHManager.getFileInfo(serverId, smilPath);
            return fileInfo.exists;
        } catch (error) {
            console.error(`Erro ao verificar SMIL para ${userLogin}:`, error);
            return false;
        }
    }

    // Escapar caracteres especiais para XML
    escapeXML(str) {
        if (!str) return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Gerar SMIL para todos os usuários (manutenção)
    async generateAllUsersSMIL() {
        try {
            console.log('🔄 Gerando arquivos SMIL para todos os usuários...');

            // Buscar todos os usuários ativos
            const [userRows] = await db.execute(
                `SELECT DISTINCT 
                    s.codigo_cliente as user_id,
                    s.email,
                    s.codigo_servidor
                 FROM streamings s 
                 WHERE s.status = 1 AND s.email IS NOT NULL`
            );

            const results = [];

            for (const user of userRows) {
                try {
                    const userLogin = user.email.split('@')[0];
                    const serverId = user.codigo_servidor || 1;

                    const result = await this.generateUserSMIL(user.user_id, userLogin, serverId);
                    results.push({
                        user_login: userLogin,
                        user_id: user.user_id,
                        server_id: serverId,
                        result: result
                    });
                } catch (userError) {
                    console.error(`Erro ao processar usuário ${user.email}:`, userError);
                    results.push({
                        user_login: user.email?.split('@')[0] || 'unknown',
                        user_id: user.user_id,
                        result: { success: false, error: userError.message }
                    });
                }
            }

            const successCount = results.filter(r => r.result.success).length;
            console.log(`✅ Arquivos SMIL gerados: ${successCount}/${results.length} usuários`);

            return {
                success: true,
                total_users: results.length,
                success_count: successCount,
                results: results
            };

        } catch (error) {
            console.error('Erro ao gerar SMIL para todos os usuários:', error);
            return { success: false, error: error.message };
        }
    }
}

module.exports = new PlaylistSMILService();