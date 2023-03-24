import { CommentContextActionEvent, Context, Devvit, KeyValueStorage, PostContextActionEvent, RedditAPIClient, UserContext, ConfigFormBuilder } from '@devvit/public-api';
import { Metadata } from '@devvit/protos';
const strikeMessages = {
    first: [
        "Dear $NAME",
        "",
        "You have received a strike in r/$SUBREDDIT for the following reason:",
        "",
        "$REASON",
        "",
        "This is your first strike and therefore, you are only receiving a warning. Your next strike will result in a one day ban.",
        "",
        "Please review the rules of the subreddit and try to avoid breaking them again.",
        "",
        "If you have any questions, please feel free to message the moderators.",
        "",
        "Thank you for your cooperation.",
        "",
        "Signed",
        "r/$SUBREDDIT moderators",
        "",
        "---"
    ],
    second: [
        "Dear $NAME",
        "",
        "You have received a strike in r/$SUBREDDIT for the following reason:",
        "",
        "$REASON",
        "",
        "This is your second strike and therefore, you are receiving a one day ban. All future strikes will result in a one year ban.",
        "",
        "Please review the rules of the subreddit and try to avoid breaking them again.",
        "",
        "If you have any questions, please feel free to message the moderators.",
        "",
        "Thank you for your cooperation.",
        "",
        "Signed",
        "r/$SUBREDDIT moderators",
        "",
        "---"
    ],
    other: [
        "Dear $NAME",
        "",
        "You have received a strike in r/$SUBREDDIT for the following reason:",
        "",
        "$REASON",
        "",
        "This is your $STRIKES strike and therefore, this and all future strikes will result in a one year ban.",
        "",
        "Please review the rules of the subreddit and try to avoid breaking them again.",
        "",
        "If you have any questions, please feel free to message the moderators.",
        "",
        "Thank you for your cooperation.",
        "",
        "Signed",
        "r/$SUBREDDIT moderators",
        "",
        "---"
    ],
    removal: [
        "Dear $NAME",
        "",
        "You have been absolved of a strike. You are now at $STRIKES strike(s).",
        "",
        "If you have any questions, please feel free to message the moderators.",
        "",
        "Thank you for your cooperation.",
        "",
        "Signed",
        "r/$SUBREDDIT moderators",
        "",
        "---"
    ],
    reset: [
        "Dear $NAME",
        "",
        "You have had your strikes reset. All previous strikes have been removed and you are now free to post in r/$SUBREDDIT.",
        "",
        "If you have any questions, please feel free to message the moderators.",
        "",
        "Thank you for your cooperation.",
        "",
        "Signed",
        "r/$SUBREDDIT moderators",
        "",
        "---"
    ],
}

const ReApprovalBase = [
    "Dear $NAME",
    "",
    "Your $TYPE was accidentally removed by a moderator. We have re-approved it and it should be visible again.",
    "We sincerely apologize for the inconvenience.",
    "",
    "If you have any questions, please feel free to message the moderators.",
    "",
    "Thank you for your cooperation.",
    "",
    "Signed",
    "r/$SUBREDDIT moderators",
    "",
    "---",
    "Note from the moderator:",
    "",
    "$REASON",
    "",
    "---"
]
const reddit = new RedditAPIClient()
const kv = new KeyValueStorage();

class Strikes {
    public static getKeyForAuthor(author: string): string {
        return `u_${author}_strikes`;
    }
    public static async generateStrikeMessage(action: 'add' | 'remove' | 'clear', metadata: { subreddit: string, name: string; reason?: string; strikes?: number; }) {
        let fileData: string;
        switch (action) {
            case 'add':
                switch (metadata.strikes) {
                    case 1:
                        fileData = strikeMessages['first'].join('\n');
                        break;
                    case 2:
                        fileData = strikeMessages['second'].join('\n');
                        break;
                    default:
                        fileData = strikeMessages['other'].join('\n');
                        break;
                }
                break;
            case 'remove':
                fileData = strikeMessages['removal'].join('\n');
                break;
            case 'clear':
                fileData = strikeMessages['reset'].join('\n');
                break;
            default:
                return '';
        }

        return fileData
            .replace(/(\$STRIKES)/gmi, (metadata.strikes ?? 0).toString())
            .replace(/(\$SUBREDDIT)/gmi, metadata.subreddit)
            .replace(/(\$NAME)/gmi, metadata.name)
            .replace(/(\$REASON)/gmi, metadata.reason ?? '');
    }
    public static async getAuthorStrikes(author: string, metadata?: Metadata): Promise<number> {
        const key = Strikes.getKeyForAuthor(author);
        return (await kv.get(key, metadata, 0)) as number;
    }
    public static async checkStrikes(event: PostContextActionEvent | CommentContextActionEvent, metadata?: Metadata) {
        // Get some relevant data from the post or comment
        let author = (event.context === Context.POST ? event.post.author : event.comment.author);

        const strikes = await Strikes.getAuthorStrikes(author!, metadata);

        return { success: true, message: `Author u/${author} has ${strikes} strike${strikes !== 1 ? 's' : ''}.`, };
    }
    public static async setAuthorStrikes(author: string, strikes: number, metadata?: Metadata) {
        const key = Strikes.getKeyForAuthor(author);
        await kv.put(key, strikes, metadata);
    }
    public static async removeStrike(event: PostContextActionEvent | CommentContextActionEvent, metadata?: Metadata) {
        // Get some relevant data from the post or comment
        let author = (event.context === Context.POST ? event.post.author : event.comment.author);
        if (!author) return { success: false, message: `Could not get author of the comment or post`, };

        const subreddit = await reddit.getCurrentSubreddit(metadata);

        let strikes = await Strikes.getAuthorStrikes(author, metadata);

        if (strikes === 0) return { success: false, message: `u/${author} does not have any strikes!`, };

        if (strikes >= 2) subreddit.getBannedUsers({ username: author }).children.filter((user) => user.username === author).forEach(async (user) => await subreddit.unbanUser(user.username));

        await Strikes.setAuthorStrikes(author, --strikes, metadata);

        const pmMessage = await Strikes.generateStrikeMessage('remove', { subreddit: subreddit.name, name: author, strikes, reason: 'N/A', });

        reddit.sendPrivateMessageAsSubreddit(
            {
                fromSubredditName: subreddit.name,
                to: author,
                subject: `Strike removed from u/${author}!`,
                text: pmMessage,
            },
            metadata,
        )

        return { success: true, message: `Removed a strike from u/${author}. Remaining strikes: ${strikes}.`, };
    }
    public static async clearStrikes(event: PostContextActionEvent | CommentContextActionEvent, metadata?: Metadata) {
        // Get some relevant data from the post or comment
        let author = (event.context === Context.POST ? event.post.author : event.comment.author);
        if (!author) return { success: false, message: 'Could not get author of post or comment.', };

        const subreddit = await reddit.getCurrentSubreddit(metadata);

        const hadStrikes = await Strikes.getAuthorStrikes(author, metadata);

        if (hadStrikes === 0) return { success: false, message: `u/${author} does not have any strikes!`, };

        if (hadStrikes >= 2) subreddit.getBannedUsers({ username: author }).children.filter((user) => user.username === author).forEach(async (user) => await subreddit.unbanUser(user.username));

        await Strikes.setAuthorStrikes(author, 0, metadata);

        const pmMessage = await Strikes.generateStrikeMessage('clear', { subreddit: subreddit.name, name: author, reason: 'N/A', });

        reddit.sendPrivateMessageAsSubreddit(
            {
                fromSubredditName: subreddit.name,
                to: author,
                subject: `Strike reset from u/${author}!`,
                text: pmMessage,
            },
            metadata
        )

        return {
            success: true,
            message: `Cleared ${hadStrikes} strike${hadStrikes !== 1 ? 's' : ''} from u/${author}!`,
        };
    }
    public static async strike(event: PostContextActionEvent | CommentContextActionEvent, metadata?: Metadata) {
        const contextType = event.context

        let id: string | undefined, author: string | undefined, permalink: string | undefined;

        id = (event.context === Context.POST ? `t3_${event.post.id}` : `t1_${event.comment.id}`);
        author = (event.context === Context.POST ? event.post.author : event.comment.author);
        permalink = (event.context === Context.POST ? event.post.permalink : event.comment.permalink);

        if (!id || !author || !permalink) {
            return {
                success: false,
                message: `Metadata is missing for ${contextType}!`,
            };
        }

        const reason = event.userInput?.fields.find((f) => f.key === 'reason')?.response || '';

        await reddit.remove(id, false, metadata);

        let strikes = await Strikes.getAuthorStrikes(author!, metadata);
        await Strikes.setAuthorStrikes(author, ++strikes, metadata);

        let pmMessage = '';
        let punishment = '';
        let ban = true;
        let days = 0;

        const subreddit = await reddit.getCurrentSubreddit(metadata);

        switch (strikes) {
            case 1:
                // first strike, send a warning
                punishment = `sent a warning`;
                ban = false;
                break;
            case 2:
                // second strike, temp ban, warn again
                days = 1;
                punishment = `banned for 1 day`;
                break;
            case 3:
            default:
                // third (and any subsequent strikes), ban for 1 year from now
                days = 365;
                punishment = `banned for 1 year`;
                break;
        }

        pmMessage = await Strikes.generateStrikeMessage('add', { subreddit: subreddit.name, name: author, strikes, reason });

        await reddit.sendPrivateMessageAsSubreddit(
            {
                fromSubredditName: subreddit.name,
                to: author,
                subject: `Received a strike on ${subreddit.name}`,
                text: pmMessage,
            },
            metadata
        );

        const result = `u/${author} has ${strikes} strike${strikes !== 1 ? 's' : ''} and has been ${punishment}.`;

        if (ban) {
            const currentUser = await reddit.getCurrentUser(metadata);
            await reddit.banUser(
                {
                    subredditName: subreddit.name,
                    username: author,
                    duration: days,
                    context: id,
                    reason: `Received ${strikes} strike${strikes !== 1 ? 's' : ''} for breaking subreddit rules`,
                    note: `Strike added by ${currentUser.username}`,
                },
                metadata
            );
        }

        return {
            success: true,
            message: result,
        };
    }
}

class ModActions {
    public static async undoRemoval(event: PostContextActionEvent | CommentContextActionEvent, metadata?: Metadata) {
        const subreddit = (await reddit.getCurrentSubreddit(metadata));
        const author = (event.context === Context.POST ? event.post.author : event.comment.author);
        const ID = (event.context === Context.POST ? event.post.linkId : event.comment.linkId);
        const contextType = event.context;

        if (!ID || !contextType || !subreddit || !author) return { success: false, message: `Metadata is missing!`, };
        const reason = event.userInput?.fields.find((f) => f.key === 'reason')?.response || '';
        const reasonMessage = ReApprovalBase.join('\n').replace(/($SUBREDDIT)/gmi, subreddit.name).replace(/($NAME)/gmi, author).replace(/($TYPE)/gmi, contextType).replace(/($REASON)/gmi, reason);
        reddit.approve(ID, metadata);

        reddit.sendPrivateMessageAsSubreddit(
            {
                fromSubredditName: subreddit.name,
                to: author,
                subject: `Your post/comment was approved on ${subreddit.name}`,
                text: reasonMessage,
            }
        )

        return { success: true, message: `Approved ${contextType} by u/${author}!`, };
    }
}

Devvit.addActions([
    {
        name: 'Remove and Strike',
        description: 'Remove this and add a strike to the author',
        context: Context.POST,
        userContext: UserContext.MODERATOR,
        userInput: new ConfigFormBuilder().textarea('reason', 'Reason for strike').build(),
        handler: Strikes.strike,
    },
    {
        name: 'Remove and Strike',
        description: 'Remove this and add a strike to the author',
        context: Context.COMMENT,
        userContext: UserContext.MODERATOR,
        userInput: new ConfigFormBuilder().textarea('reason', 'Reason for strike').build(),
        handler: Strikes.strike,
    },
    {
        name: `Check User's Strikes`,
        description: 'Tells you how many strikes the author has',
        context: Context.POST,
        userContext: UserContext.MODERATOR,
        handler: Strikes.checkStrikes,
    },
    {
        name: `Check User's Strikes`,
        description: 'Tells you how many strikes the author has',
        context: Context.COMMENT,
        userContext: UserContext.MODERATOR,
        handler: Strikes.checkStrikes,
    },
    {
        name: 'Remove Strike from Author',
        description: 'Remove a strike from the author of this content',
        context: Context.POST,
        userContext: UserContext.MODERATOR,
        handler: Strikes.removeStrike,
    },
    {
        name: 'Remove Strike from Author',
        description: 'Remove a strike from the author of this content',
        context: Context.COMMENT,
        userContext: UserContext.MODERATOR,
        handler: Strikes.removeStrike,
    },
    {
        name: 'Remove All Strikes from Author',
        description: `Reset the author's strike count to zero`,
        context: Context.POST,
        userContext: UserContext.MODERATOR,
        handler: Strikes.clearStrikes,
    },
    {
        name: 'Remove All Strikes from Author',
        description: `Reset the author's strike count to zero`,
        context: Context.COMMENT,
        userContext: UserContext.MODERATOR,
        handler: Strikes.clearStrikes,
    },
    {
        name: 'Undo Removal',
        description: 'Undo the removal of this post/comment',
        context: Context.POST,
        userContext: UserContext.MODERATOR,
        userInput: new ConfigFormBuilder().textarea('reason', 'Reason for undoing removal').build(),
        handler: ModActions.undoRemoval,
    },
    {
        name: 'Undo Removal',
        description: 'Undo the removal of this post/comment',
        context: Context.COMMENT,
        userContext: UserContext.MODERATOR,
        userInput: new ConfigFormBuilder().textarea('reason', 'Reason for undoing removal').build(),
        handler: ModActions.undoRemoval,
    },
]);

export default Devvit;