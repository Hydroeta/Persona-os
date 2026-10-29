"""Self-service QQ account actions for the authorized continuous-chat agent.

These tools intentionally sit behind the same chat+send grant as group chatting:
the local user explicitly gave the agent standing permission to run this QQ
account. Hard local limits cap how often the agent may change its own profile,
post Qzone content, or open a private chat, so a confused loop cannot spam.
Nothing here ever acts on other people's accounts or group administration.
"""
import os
import re
import time

TOOLS = {'set_chat_self_profile', 'set_chat_self_signature', 'set_chat_self_avatar',
         'publish_chat_qzone', 'send_chat_direct_message'}

# kind -> (max attempts per rolling 24h, minimum seconds between attempts)
LIMITS = {
    'profile_nick': (2, 300),
    'profile_note': (3, 300),
    'profile_sex': (2, 300),
    'signature': (5, 120),
    'avatar': (3, 600),
    'qzone': (3, 1800),
    'direct_total': (20, 0),
}
DIRECT_TARGET_COOLDOWN = 600  # one unprompted DM per friend per 10 minutes
QZONE_RIGHTS = {1: '所有人可见', 4: '好友可见', 64: '仅自己可见'}
AI_MARKERS = ('AI生成', 'AI 生成', 'AI-generated', '由AI', '人工智能生成')
IMAGE_SUFFIX = ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp')


def schemas(tool):
    sid = dict(type='string', minLength=32, maxLength=32, description='原样复制返回的字符串；JSON 中必须加双引号。')
    key = dict(idempotency_key=dict(type='string', minLength=8, maxLength=80))
    return [
        tool('set_chat_self_profile',
             '修改机器人自己的 QQ 昵称或个人说明（个人资料页的说明），也可设置性别。三项都可选但至少传一项；昵称仍是小鲸鱼/DeepSeek 相关身份，不要改成冒充真人或他人的名字。本机限制每天少量修改，失败不要反复试。',
             dict(nickname=dict(type='string', minLength=1, maxLength=30, description='新昵称，单行，不含换行。'),
                  personal_note=dict(type='string', maxLength=100, description='个人说明，可传空字符串清空。'),
                  sex=dict(type='integer', enum=[0, 1, 2], description='0 未知/保密，1 男，2 女')),
             []),
        tool('set_chat_self_signature',
             '修改机器人自己的 QQ 个性签名（longNick）。传空字符串可清空。签名要符合小鲸鱼人设，每天最多改几次。',
             dict(text=dict(type='string', maxLength=100)), ['text']),
        tool('set_chat_self_avatar',
             '把机器人的 QQ 头像换成指定图片。image 支持 http(s):// 图片地址、本机 file:/// 绝对路径或 base64:// 数据；只使用你确实看过来源、内容正常的图片，不用来历不明或违规图。每天最多换 3 次。',
             dict(image=dict(type='string', minLength=8, maxLength=2000000,
                             description='http(s):// / file:/// / base64:// 形式的图片来源。')), ['image']),
        tool('publish_chat_qzone',
             '用机器人账号发一条 QQ 空间说说。程序会自动在末尾补上“（AI生成）”标注，不许删；内容是小鲸鱼视角的日常/吐槽/玩梗，短而自然，不发广告、不碰敏感时政、不刷屏。默认好友可见。',
             dict(content=dict(type='string', minLength=1, maxLength=500, description='说说正文；不含标注，程序自动追加。'),
                  ugc_right=dict(type='integer', enum=[1, 4, 64], default=4,
                                 description='查看权限：1 所有人，4 好友（默认），64 仅自己。')),
             ['content']),
        tool('send_chat_direct_message',
             '从当前群聊会话主动给本群的一位群友发私聊（send_private_msg）。只在群里实在聊不过/想私下补刀或解释、且对方是已加好友时偶尔用；不是正常回复通道，群里能接的话一律在群里说，不许群发、推销或骚扰。本机对同一好友 10 分钟最多 1 条、每天总量有限。',
             dict(session_id=sid, **key,
                  user_id=dict(type='string', pattern='^[1-9][0-9]{0,19}$', description='该群成员的 QQ 号，用消息里的 sender_id，不要用昵称猜。'),
                  text=dict(type='string', minLength=1, maxLength=500, description='私聊正文，遵守人格语言规则。')),
             ['session_id', 'user_id', 'text', 'idempotency_key']),
    ]


class SelfActionError(ValueError):
    pass


class ChatSelfActions:
    def __init__(self, chat):
        self.chat = chat
        self.access = chat.access

    def _db(self):
        return self.access.connect()

    def _record(self, kind, target, detail, at=None):
        with self._db() as db:
            db.execute('INSERT INTO chat_self_actions(kind,target,at,detail) VALUES(?,?,?,?)',
                       (kind, target or '', at or time.time(), (detail or '')[:500]))

    def _limit(self, kind, target=''):
        cap, interval = LIMITS[kind]
        now = time.time()
        with self._db() as db:
            count = db.execute('SELECT count(*) FROM chat_self_actions WHERE kind=? AND target=? AND at>?',
                               (kind, target, now - 86400)).fetchone()[0]
            last = db.execute('SELECT max(at) FROM chat_self_actions WHERE kind=? AND target=?',
                              (kind, target)).fetchone()[0]
        if count >= cap:
            raise SelfActionError(f'该操作每天限 {cap} 次，已达上限，明天再试。')
        if interval and last and now - last < interval:
            raise SelfActionError(f'两次操作需间隔至少 {interval} 秒，请再等 {int(interval-(now-last))} 秒。')

    def _client(self):
        return self.chat.actions.client_factory(timeout=20)

    def call(self, grant, name, args):
        if name == 'set_chat_self_profile':
            return self.set_profile(args)
        if name == 'set_chat_self_signature':
            return self.set_signature(args)
        if name == 'set_chat_self_avatar':
            return self.set_avatar(args)
        if name == 'publish_chat_qzone':
            return self.publish_qzone(args)
        if name == 'send_chat_direct_message':
            return self.send_direct(grant, args)
        raise ValueError('未知自助操作。')

    def set_profile(self, args):
        nickname = args.get('nickname')
        note = args.get('personal_note')
        sex = args.get('sex')
        provided = [k for k in ('nickname', 'personal_note', 'sex') if k in args]
        if not provided:
            raise SelfActionError('至少提供 nickname / personal_note / sex 中的一项。')
        if nickname is not None and (not isinstance(nickname, str) or not nickname.strip() or '\n' in nickname
                                     or any(ord(c) < 32 for c in nickname)):
            raise SelfActionError('昵称须为 1~30 字单行文本。')
        if note is not None and (not isinstance(note, str) or len(note) > 100 or any(ord(c) < 32 for c in note)):
            raise SelfActionError('个人说明须为 100 字以内单行文本。')
        fields = []
        if nickname is not None: fields.append('profile_nick')
        if note is not None: fields.append('profile_note')
        if sex is not None: fields.append('profile_sex')
        for kind in fields:
            self._limit(kind)
        payload = {}
        if nickname is not None: payload['nickname'] = nickname.strip()
        if note is not None: payload['personal_note'] = note
        if sex is not None: payload['sex'] = sex
        data = self._client().call('set_qq_profile', payload, approved=True)
        for kind in fields:
            self._record(kind, '', json_dump(payload))
        return dict(state='SUCCEEDED', changed=fields, note='QQ 资料已更新；客户端显示可能有延迟。')

    def set_signature(self, args):
        text = args.get('text')
        if not isinstance(text, str) or len(text) > 100 or any(ord(c) < 32 for c in text):
            raise SelfActionError('个性签名须为 100 字以内单行文本（可为空）。')
        self._limit('signature')
        self._client().call('set_self_longnick', {'longNick': text}, approved=True)
        self._record('signature', '', text)
        return dict(state='SUCCEEDED', note='个性签名已更新。')

    def set_avatar(self, args):
        image = args.get('image', '')
        if not isinstance(image, str) or len(image) < 8:
            raise SelfActionError('请提供图片来源。')
        if image.startswith('http://') or image.startswith('https://'):
            pass
        elif image.startswith('file:///'):
            path = image[8:]
            if not os.path.isabs(path) or not os.path.isfile(path):
                raise SelfActionError('本机图片不存在，请核对 file:/// 绝对路径。')
            if path.lower().endswith(IMAGE_SUFFIX) is False:
                raise SelfActionError('仅支持 png/jpg/jpeg/gif/webp/bmp 图片。')
        elif image.startswith('base64://'):
            if not re.fullmatch(r'base64://[A-Za-z0-9+/=\r\n]+', image):
                raise SelfActionError('base64 图片格式无效。')
        else:
            raise SelfActionError('图片仅支持 http(s)://、file:///、base64:// 三种来源。')
        self._limit('avatar')
        self._client().call('set_qq_avatar', {'file': image}, approved=True)
        self._record('avatar', '', image[:120])
        return dict(state='SUCCEEDED', note='头像更新请求已被 QQ 接受，生效可能有延迟。')

    def publish_qzone(self, args):
        content = args.get('content', '')
        right = args.get('ugc_right', 4)
        if not isinstance(content, str) or not content.strip() or len(content) > 500:
            raise SelfActionError('说说正文须为 1~500 字。')
        if right not in QZONE_RIGHTS:
            raise SelfActionError('查看权限仅支持 1/4/64。')
        content = content.strip()
        if not any(marker in content for marker in AI_MARKERS):
            content = content.rstrip('。.!！?？ ') + '（AI生成）'
        self._limit('qzone')
        data = self._client().call('send_qzone_msg',
                                   dict(content=content, ugc_right=right), approved=True)
        tid = ''
        if isinstance(data, dict):
            tid = str(data.get('tid') or data.get('feed_id') or '')
        self._record('qzone', tid, content)
        return dict(state='SUCCEEDED', content=content, ugc_right=right, tid=tid,
                    note='说说已发表，已自动标注 AI 生成。')

    def send_direct(self, grant, args):
        sid = args['session_id']
        grant, row = self.chat.validate(sid, grant['id'])
        cid = row['conversation_id']
        parts = cid.split(':')
        if len(parts) != 3 or parts[1] != 'group':
            raise SelfActionError('私聊工具只能从群聊会话中发起；好友私聊会话里直接正常回复即可。')
        account, group = parts[0], parts[2]
        uid = str(args.get('user_id', ''))
        text = args.get('text', '')
        if not uid.isascii() or not uid.isdigit() or uid == '0':
            raise SelfActionError('user_id 必须是 QQ 号数字。')
        if not isinstance(text, str) or not text.strip() or len(text) > 500 or any(ord(c) < 32 and c not in '\n\t' for c in text):
            raise SelfActionError('私聊正文须为 1~500 字。')
        # 1) the target must currently be a member of this agent's group
        client = self._client()
        try:
            member = client.call('get_group_member_info',
                                 dict(group_id=int(group), user_id=int(uid), no_cache=True))
        except Exception:
            member = None
        if not isinstance(member, dict) or str(member.get('user_id')) != uid:
            raise SelfActionError('对方不是本群成员，不能通过本群会话发起私聊。')
        # 2) hard rate limits
        self._limit('direct_total')
        now = time.time()
        with self._db() as db:
            last = db.execute('SELECT max(at) FROM chat_self_actions WHERE kind=? AND target=?',
                              ('direct_user', uid)).fetchone()[0]
        if last and now - last < DIRECT_TARGET_COOLDOWN:
            raise SelfActionError(f'10 分钟内刚私聊过该群友，再等 {int(DIRECT_TARGET_COOLDOWN-(now-last))} 秒。')
        # 3) sender adapter re-verifies login and friend relationship
        sender = self.chat.actions.sender_factory()
        target = dict(platform='qq', conversation_id=f'{account}:direct:{uid}',
                      conversation=str(member.get('card') or member.get('nickname') or uid))
        prepared = sender.prepare(target, False)
        try:
            receipt = sender.send(target, text, prepared)
        except Exception as exc:
            # Record the attempt only on hard refusal paths separately; uncertain
            # sends must not be retried, surface that verbatim to the agent.
            raise SelfActionError(str(exc)) from None
        self._record('direct_user', uid, text)
        self._record('direct_total', '', f'{uid}:{text[:80]}')
        return dict(state='SUCCEEDED', user_id=uid, name=prepared.get('name'),
                    message_id=receipt.get('message_id'), note='私聊已发送；不要连续再发，等对方回复。')


def json_dump(value):
    import json
    return json.dumps(value, ensure_ascii=False)[:500]
