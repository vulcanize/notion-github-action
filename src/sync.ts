import {Client} from '@notionhq/client/build/src';
import {Issue} from '@octokit/webhooks-types/schema';
import * as core from '@actions/core';
import {Octokit} from 'octokit';
import {CustomValueMap, properties} from './properties';
import {getProjectData} from './action';
import {QueryDatabaseResponse} from '@notionhq/client/build/src/api-endpoints';
import {CustomTypes} from './api-types';
import {parseBodyRichText} from './action';

type PageIdAndIssueID = {
  pageId: string;
  issueID: number;
};

export async function createIssueMapping(
  notion: Client,
  databaseId: string
): Promise<Map<number, string>> {
  const issuePageIds = new Map<number, string>();
  const issuesAlreadyInNotion: {
    pageId: string;
    issueID: number;
  }[] = await getIssuesAlreadyInNotion(notion, databaseId);
  for (const {pageId, issueID} of issuesAlreadyInNotion) {
    issuePageIds.set(issueID, pageId);
  }
  return issuePageIds;
}

export async function syncNotionDBWithGitHub(
  issuePageIds: Map<number, string>,
  octokit: Octokit,
  notion: Client,
  databaseId: string,
  githubRepo: string
) {
  const issues = await getGitHubIssues(octokit, githubRepo);
  const pagesToCreate = getIssuesNotInNotion(issuePageIds, issues);
  await createPages(notion, databaseId, pagesToCreate, octokit);
}

// Notion SDK for JS: https://developers.notion.com/reference/post-database-query
async function getIssuesAlreadyInNotion(
  notion: Client,
  databaseId: string
): Promise<PageIdAndIssueID[]> {
  core.info('Checking for issues already in the database...');
  const pages: QueryDatabaseResponse['results'] = [];
  let cursor = undefined;
  let next_cursor: string | null = 'true';
  while (next_cursor) {
    const response: QueryDatabaseResponse = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
    });
    next_cursor = response.next_cursor;
    const results = response.results;
    pages.push(...results);
    if (!next_cursor) {
      break;
    }
    cursor = next_cursor;
  }

  const res: PageIdAndIssueID[] = [];

  pages.forEach(page => {
    if ('properties' in page) {
      let num: number | null = null;
      num = (page.properties['ID'] as CustomTypes.Number).number as number;
      if (typeof num !== 'undefined')
        res.push({
          pageId: page.id,
          issueID: num,
        });
    }
  });

  return res;
}

// https://docs.github.com/en/rest/reference/issues#list-repository-issues
async function getGitHubIssues(octokit: Octokit, githubRepo: string): Promise<Issue[]> {
  core.info('Finding Github Issues...');
  const issues: Issue[] = [];
  const iterator = octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
    owner: githubRepo.split('/')[0],
    repo: githubRepo.split('/')[1],
    state: 'all',
    per_page: 100,
  });
  for await (const {data} of iterator) {
    for (const issue of data) {
      if (!issue.pull_request) {
        issues.push(<Issue>issue);
      }
    }
  }
  return issues;
}

function getIssuesNotInNotion(issuePageIds: Map<number, string>, issues: Issue[]): Issue[] {
  const pagesToCreate: Issue[] = [];
  for (const issue of issues) {
    if (!issuePageIds.has(issue.id)) {
      pagesToCreate.push(issue);
      core.info(`Found an issue to add ${issue.number}, ${issue.id}`);
    }
  }
  return pagesToCreate;
}

// Notion SDK for JS: https://developers.notion.com/reference/post-page
async function createPages(
  notion: Client,
  databaseId: string,
  pagesToCreate: Issue[],
  octokit: Octokit
): Promise<void> {
  core.info('Adding Github Issues to Notion...');
  await Promise.all(
    pagesToCreate.map(async issue =>
      notion.pages.create({
        parent: {database_id: databaseId},
        properties: await getPropertiesFromIssue(issue, octokit),
      })
    )
  );
}

/*
 *  For the `Assignees` field in the Notion DB we want to send only issues.assignees.login
 *  For the `Labels` field in the Notion DB we want to send only issues.labels.name
 */
function createMultiSelectObjects(issue: Issue): {
  assigneesObject: string[];
  labelsObject: string[] | undefined;
} {
  const assigneesObject = issue.assignees.map((assignee: {login: string}) => assignee.login);
  const labelsObject = issue.labels?.map((label: {name: string}) => label.name);
  return {assigneesObject, labelsObject};
}

async function getPropertiesFromIssue(issue: Issue, octokit: Octokit): Promise<CustomValueMap> {
  const {
    number,
    title,
    state,
    id,
    milestone,
    created_at,
    updated_at,
    body,
    repository_url,
    user,
    html_url,
  } = issue;
  const author = user?.login;
  const {assigneesObject, labelsObject} = createMultiSelectObjects(issue);
  const urlComponents = repository_url.split('/');
  const org = urlComponents[urlComponents.length - 2];
  const repo = urlComponents[urlComponents.length - 1];

  const projectData = await getProjectData({
    octokit,
    githubRepo: `${org}/${repo}`,
    issueNumber: issue.number,
  });

  // These properties are specific to the template DB referenced in the README.
  return {
    Name: properties.title(title),
    Status: properties.getStatusSelectOption(state!),
    Organization: properties.text(org),
    Repository: properties.text(repo),
    Body: properties.richText(parseBodyRichText(body || '')),
    Number: properties.number(number),
    Assignees: properties.multiSelect(assigneesObject),
    Milestone: properties.text(milestone ? milestone.title : ''),
    Labels: properties.multiSelect(labelsObject ? labelsObject : []),
    Author: properties.text(author),
    Created: properties.date(created_at),
    Updated: properties.date(updated_at),
    ID: properties.number(id),
    Link: properties.url(html_url),
    Project: properties.text(projectData?.name || ''),
    'Project Column': properties.text(projectData?.columnName || ''),
  };
}
